//! Calendar queries over the renderer's public daily aggregate projection.
use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Totals {
    #[serde(deserialize_with = "deserialize_integer")]
    breaks_completed: u64,
    #[serde(deserialize_with = "deserialize_integer")]
    exercises_completed: u64,
    focus_minutes: f64,
    work_minutes: f64,
    away_minutes: f64,
    pause_minutes: f64,
    rest_minutes: f64,
    recorded_minutes: f64,
}

impl Totals {
    fn valid(&self) -> bool {
        self.breaks_completed <= MAX_SAFE_INTEGER
            && self.exercises_completed <= MAX_SAFE_INTEGER
            && [
                self.focus_minutes,
                self.work_minutes,
                self.away_minutes,
                self.pause_minutes,
                self.rest_minutes,
                self.recorded_minutes,
            ]
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0)
    }

    fn add(&mut self, other: &Self) -> Option<()> {
        self.breaks_completed = self.breaks_completed.checked_add(other.breaks_completed)?;
        self.exercises_completed = self
            .exercises_completed
            .checked_add(other.exercises_completed)?;
        self.focus_minutes += other.focus_minutes;
        self.work_minutes += other.work_minutes;
        self.away_minutes += other.away_minutes;
        self.pause_minutes += other.pause_minutes;
        self.rest_minutes += other.rest_minutes;
        self.recorded_minutes += other.recorded_minutes;
        // Never emit a rounded integer counter or a non-finite aggregate.
        self.valid().then_some(())
    }
}

struct Day {
    date: NaiveDate,
    totals: Totals,
}

pub(super) struct Snapshot {
    time_zone: String,
    activity_start_date: Option<NaiveDate>,
    days: Vec<Day>,
}

#[derive(Clone, Copy, PartialEq)]
enum GroupBy {
    Day,
    Week,
}

pub(super) struct Query {
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    group_by: GroupBy,
    offset: u64,
    limit: usize,
}

pub(super) enum QueryError {
    InvalidRange,
    InvalidData,
}

fn date(value: &str) -> Option<NaiveDate> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return None;
    }
    let year = value[0..4].parse::<i32>().ok()?;
    if year == 0 {
        return None;
    }
    NaiveDate::from_ymd_opt(year, value[5..7].parse().ok()?, value[8..10].parse().ok()?)
}

fn optional_date(value: Option<&Value>) -> Result<Option<NaiveDate>, &'static str> {
    match value {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .and_then(date)
            .map(Some)
            .ok_or("Dates must be real YYYY-MM-DD calendar dates"),
    }
}

fn integer(value: &Value) -> Option<u64> {
    let value = value.as_f64()?;
    (value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= MAX_SAFE_INTEGER as f64)
        .then_some(value as u64)
}

fn deserialize_integer<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    integer(&value).ok_or_else(|| serde::de::Error::custom("Expected a nonnegative safe integer"))
}

pub(super) fn parse_query(arguments: &Value) -> Result<Query, &'static str> {
    let object = arguments.as_object().ok_or("Arguments must be an object")?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "startDate" | "endDate" | "groupBy" | "offset" | "limit"
        )
    }) {
        return Err("Unknown statistics argument");
    }
    let start_date = optional_date(object.get("startDate"))?;
    let end_date = optional_date(object.get("endDate"))?;
    if matches!((start_date, end_date), (Some(start), Some(end)) if start > end) {
        return Err("startDate must not be after endDate");
    }
    let group_by = match object.get("groupBy") {
        None => GroupBy::Day,
        Some(Value::String(value)) if value == "day" => GroupBy::Day,
        Some(Value::String(value)) if value == "week" => GroupBy::Week,
        _ => return Err("groupBy must be day or week"),
    };
    let offset = match object.get("offset") {
        None => 0,
        Some(value) => integer(value).ok_or("offset must be a nonnegative safe integer")?,
    };
    let limit = match object.get("limit") {
        None => 100,
        Some(value) => match integer(value) {
            Some(value) if (1..=366).contains(&value) => value as usize,
            _ => return Err("limit must be an integer from 1 to 366"),
        },
    };
    Ok(Query {
        start_date,
        end_date,
        group_by,
        offset,
        limit,
    })
}

fn formatted(value: Option<NaiveDate>) -> Option<String> {
    value.map(|value| value.format("%Y-%m-%d").to_string())
}

fn calendar_days(start: NaiveDate, end: NaiveDate) -> i64 {
    (end - start).num_days() + 1
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Period {
    start_date: String,
    end_date: String,
    calendar_days: i64,
    recorded_days: usize,
    totals: Totals,
}

impl Snapshot {
    pub(super) fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.len() != 3 {
            return None;
        }
        let time_zone = object.get("timeZone")?.as_str()?;
        if time_zone.trim().is_empty() {
            return None;
        }
        let activity_start_date = match object.get("activityStartDate")? {
            Value::Null => None,
            Value::String(value) => Some(date(value)?),
            _ => return None,
        };
        let raw_days = object.get("days")?.as_array()?;
        let mut days: Vec<Day> = Vec::with_capacity(raw_days.len());
        for value in raw_days {
            let mut object = value.as_object()?.clone();
            let day = date(object.remove("date")?.as_str()?)?;
            let totals: Totals = serde_json::from_value(Value::Object(object)).ok()?;
            if !totals.valid() || days.last().is_some_and(|previous| previous.date >= day) {
                return None;
            }
            days.push(Day { date: day, totals });
        }
        if activity_start_date.is_some_and(|start| !days.iter().any(|day| day.date == start)) {
            return None;
        }
        Some(Self {
            time_zone: time_zone.to_string(),
            activity_start_date,
            days,
        })
    }

    pub(super) fn data_range(&self) -> Value {
        json!({
            "timeZone": self.time_zone,
            "dataStartDate": formatted(self.days.first().map(|day| day.date)),
            "dataEndDate": formatted(self.days.last().map(|day| day.date)),
            "activityStartDate": formatted(self.activity_start_date),
            "recordedDays": self.days.len(),
        })
    }

    pub(super) fn stats(&self, query: &Query) -> Result<Value, QueryError> {
        let start = query
            .start_date
            .or_else(|| self.days.first().map(|day| day.date))
            .or(query.end_date);
        let end = query
            .end_date
            .or_else(|| self.days.last().map(|day| day.date))
            .or(query.start_date);
        if matches!((start, end), (Some(start), Some(end)) if start > end) {
            return Err(QueryError::InvalidRange);
        }
        let mut totals = Totals::default();
        let mut recorded_days = 0;
        let mut periods: Vec<Period> = vec![];
        let mut previous_group = None;
        if let (Some(start), Some(end)) = (start, end) {
            for day in self
                .days
                .iter()
                .filter(|day| day.date >= start && day.date <= end)
            {
                totals.add(&day.totals).ok_or(QueryError::InvalidData)?;
                recorded_days += 1;
                let group_start = if query.group_by == GroupBy::Week {
                    // Chrono supports dates beyond the public 0001..9999 range.
                    // Clamp to the query before formatting calendar week bounds.
                    day.date
                        .checked_sub_signed(Duration::days(i64::from(
                            day.date.weekday().num_days_from_monday(),
                        )))
                        .ok_or(QueryError::InvalidData)?
                } else {
                    day.date
                };
                if previous_group != Some(group_start) {
                    let group_end = if query.group_by == GroupBy::Week {
                        group_start
                            .checked_add_signed(Duration::days(6))
                            .ok_or(QueryError::InvalidData)?
                    } else {
                        group_start
                    };
                    let period_start = group_start.max(start);
                    let period_end = group_end.min(end);
                    periods.push(Period {
                        start_date: formatted(Some(period_start)).unwrap(),
                        end_date: formatted(Some(period_end)).unwrap(),
                        calendar_days: calendar_days(period_start, period_end),
                        recorded_days: 0,
                        totals: Totals::default(),
                    });
                    previous_group = Some(group_start);
                }
                let period = periods.last_mut().ok_or(QueryError::InvalidData)?;
                period.recorded_days += 1;
                period
                    .totals
                    .add(&day.totals)
                    .ok_or(QueryError::InvalidData)?;
            }
        }
        let total_periods = periods.len();
        // Clamp before conversion so large valid offsets work on 32-bit hosts.
        let offset = query.offset.min(total_periods as u64) as usize;
        let page_end = offset.saturating_add(query.limit).min(total_periods);
        let page: Vec<_> = periods.into_iter().skip(offset).take(query.limit).collect();
        let mut result = self.data_range();
        result["startDate"] = json!(formatted(start));
        result["endDate"] = json!(formatted(end));
        result["groupBy"] = json!(if query.group_by == GroupBy::Day {
            "day"
        } else {
            "week"
        });
        result["calendarDays"] = json!(match (start, end) {
            (Some(start), Some(end)) => calendar_days(start, end),
            _ => 0,
        });
        result["recordedDays"] = json!(recorded_days);
        result["totals"] = json!(totals);
        result["periods"] = json!(page);
        result["totalPeriods"] = json!(total_periods);
        result["offset"] = json!(query.offset);
        result["hasMore"] = json!(page_end < total_periods);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, count: u64) -> Value {
        json!({"date":date,"breaksCompleted":count,"exercisesCompleted":1,
            "focusMinutes":1.5,"workMinutes":2.5,"awayMinutes":3.0,
            "pauseMinutes":4.0,"restMinutes":5.0,"recordedMinutes":14.5})
    }

    fn snapshot(days: Vec<Value>) -> Snapshot {
        Snapshot::parse(&json!({"timeZone":"Europe/Madrid","activityStartDate":null,"days":days}))
            .unwrap()
    }

    fn stats(days: Vec<Value>, arguments: Value) -> Value {
        snapshot(days)
            .stats(&parse_query(&arguments).unwrap())
            .ok()
            .unwrap()
    }

    #[test]
    fn rejects_invalid_dates_types_unknown_arguments_and_inverted_ranges() {
        for arguments in [
            json!({"startDate":"2025-02-29"}),
            json!({"startDate":"2024-2-29"}),
            json!({"startDate":"0000-01-01"}),
            json!({"startDate":"10000-01-01"}),
            json!({"startDate":null}),
            json!({"startDate":"2024-03-01","endDate":"2024-02-29"}),
            json!({"offset":-1}),
            json!({"offset":1.5}),
            json!({"offset":9007199254740992_u64}),
            json!({"limit":0}),
            json!({"limit":367}),
            json!({"limit":"10"}),
            json!({"groupBy":"month"}),
            json!({"extra":1}),
            json!([]),
        ] {
            assert!(parse_query(&arguments).is_err(), "{arguments}");
        }
        assert!(parse_query(&json!({"offset":1.0,"limit":1.0})).is_ok());
        let history = snapshot(vec![day("2024-02-29", 1)]);
        assert!(matches!(
            history.stats(&parse_query(&json!({"startDate":"2024-03-01"})).unwrap()),
            Err(QueryError::InvalidRange)
        ));
    }

    #[test]
    fn empty_history_preserves_explicit_calendar_bounds() {
        let empty = stats(vec![], json!({}));
        assert!(empty["startDate"].is_null());
        assert!(empty["endDate"].is_null());
        assert!(empty["dataStartDate"].is_null());
        assert_eq!(empty["calendarDays"], 0);
        assert_eq!(empty["recordedDays"], 0);
        assert_eq!(empty["totalPeriods"], 0);
        assert_eq!(empty["totals"]["breaksCompleted"], 0);
        assert_eq!(empty["periods"], json!([]));
        let bounded = stats(
            vec![],
            json!({"startDate":"2024-02-28","endDate":"2024-03-01"}),
        );
        assert_eq!(bounded["calendarDays"], 3);
        for arguments in [
            json!({"startDate":"2024-02-29"}),
            json!({"endDate":"2024-02-29"}),
        ] {
            let bounded = stats(vec![], arguments);
            assert_eq!(bounded["startDate"], "2024-02-29");
            assert_eq!(bounded["endDate"], "2024-02-29");
            assert_eq!(bounded["calendarDays"], 1);
        }
    }

    #[test]
    fn day_pagination_keeps_full_range_totals_and_missing_dates_missing() {
        let result = stats(
            vec![day("2024-02-28", 2), day("2024-03-01", 3)],
            json!({"offset":1,"limit":1}),
        );
        assert_eq!(result["calendarDays"], 3);
        assert_eq!(result["recordedDays"], 2);
        assert_eq!(result["totalPeriods"], 2);
        assert_eq!(result["totals"]["breaksCompleted"], 5);
        assert_eq!(result["totals"]["focusMinutes"], 3.0);
        assert_eq!(result["periods"].as_array().unwrap().len(), 1);
        assert_eq!(result["periods"][0]["startDate"], "2024-03-01");
        assert_eq!(result["periods"][0]["calendarDays"], 1);
        assert_eq!(result["hasMore"], false);
        let first_page = stats(
            vec![day("2024-02-28", 2), day("2024-03-01", 3)],
            json!({"limit":1}),
        );
        assert_eq!(first_page["hasMore"], true);
        let past_end = stats(
            vec![day("2024-02-28", 2)],
            json!({"offset":9007199254740991_u64}),
        );
        assert_eq!(past_end["periods"], json!([]));
        assert_eq!(past_end["recordedDays"], 1);
        assert_eq!(past_end["hasMore"], false);
        let no_rows = stats(
            vec![day("2024-02-28", 2)],
            json!({"startDate":"2024-03-01","endDate":"2024-03-05"}),
        );
        assert_eq!(no_rows["calendarDays"], 5);
        assert_eq!(no_rows["recordedDays"], 0);
        assert_eq!(no_rows["periods"], json!([]));
    }

    #[test]
    fn calendar_weeks_are_monday_sunday_and_clipped_across_year_and_dst_edges() {
        let result = stats(
            vec![
                day("2023-12-31", 1),
                day("2024-01-01", 2),
                day("2024-01-07", 3),
                day("2024-01-08", 4),
            ],
            json!({"groupBy":"week","startDate":"2023-12-30","endDate":"2024-01-09"}),
        );
        assert_eq!(result["calendarDays"], 11);
        assert_eq!(result["totalPeriods"], 3);
        assert_eq!(result["periods"][0]["startDate"], "2023-12-30");
        assert_eq!(result["periods"][0]["endDate"], "2023-12-31");
        assert_eq!(result["periods"][0]["calendarDays"], 2);
        assert_eq!(result["periods"][1]["startDate"], "2024-01-01");
        assert_eq!(result["periods"][1]["endDate"], "2024-01-07");
        assert_eq!(result["periods"][1]["recordedDays"], 2);
        assert_eq!(result["periods"][1]["totals"]["breaksCompleted"], 5);
        assert_eq!(result["periods"][2]["endDate"], "2024-01-09");
        let dst = stats(
            vec![day("2024-03-31", 1)],
            json!({"startDate":"2024-03-30","endDate":"2024-04-01"}),
        );
        assert_eq!(dst["calendarDays"], 3);
    }

    #[test]
    fn weekly_bounds_handle_the_full_public_calendar() {
        for value in ["0001-01-01", "9999-12-31"] {
            let result = stats(vec![day(value, 1)], json!({"groupBy":"week"}));
            assert_eq!(result["periods"][0]["startDate"], value);
            assert_eq!(result["periods"][0]["endDate"], value);
            assert_eq!(result["periods"][0]["calendarDays"], 1);
        }
        let result = stats(
            vec![],
            json!({"startDate":"0001-01-01","endDate":"9999-12-31","groupBy":"week"}),
        );
        assert_eq!(result["calendarDays"], 3_652_059);
    }

    #[test]
    fn malformed_or_private_snapshots_are_rejected() {
        let mut numeric_day = day("2024-01-01", 1);
        numeric_day["breaksCompleted"] = json!(1.0);
        assert!(Snapshot::parse(
            &json!({"timeZone":"UTC","activityStartDate":null,"days":[numeric_day]})
        )
        .is_some());
        for value in [
            json!({}),
            json!({"timeZone":"","activityStartDate":null,"days":[]}),
            json!({"timeZone":"UTC","days":[]}),
            json!({"timeZone":"UTC","activityStartDate":"2023-02-29","days":[]}),
            json!({"timeZone":"UTC","activityStartDate":"2024-01-01","days":[]}),
            json!({"timeZone":"UTC","activityStartDate":"2024-01-02","days":[day("2024-01-01",1)]}),
            json!({"timeZone":"UTC","activityStartDate":null,"days":[day("2024-01-01",1),day("2024-01-01",2)]}),
            json!({"timeZone":"UTC","activityStartDate":null,"days":[day("2024-01-02",1),day("2024-01-01",2)]}),
        ] {
            assert!(Snapshot::parse(&value).is_none(), "{value}");
        }
        for (field, invalid) in [
            ("workMinutes", json!(-1)),
            ("breaksCompleted", json!(1.5)),
            ("exercisesCompleted", json!(9007199254740992_u64)),
            ("activity", json!([])),
        ] {
            let mut raw_day = day("2024-01-01", 1);
            raw_day[field] = invalid;
            assert!(Snapshot::parse(
                &json!({"timeZone":"UTC","activityStartDate":null,"days":[raw_day]})
            )
            .is_none());
        }
    }

    #[test]
    fn aggregate_overflow_is_rejected_without_rounding_or_nonfinite_output() {
        let mut first = day("2024-01-01", MAX_SAFE_INTEGER);
        let second = day("2024-01-02", 1);
        let query = parse_query(&json!({})).unwrap();
        assert!(matches!(
            snapshot(vec![first.clone(), second.clone()]).stats(&query),
            Err(QueryError::InvalidData)
        ));
        first["breaksCompleted"] = json!(1);
        first["workMinutes"] = json!(1.0e308);
        let mut second = second;
        second["workMinutes"] = json!(1.0e308);
        assert!(matches!(
            snapshot(vec![first, second]).stats(&query),
            Err(QueryError::InvalidData)
        ));
    }
}
