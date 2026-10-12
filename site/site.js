const languages = ['en','ru','es','fr','de','it','pt','zh','ja','ko','ar','hi','tr','pl','uk','hy','bn','id','vi','th','fa','ur','he','nl','sv','cs','ro','el','ta','te'];
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch { /* Session choice still works. */ } }
function match(values) {
  for (const value of values) {
    const language = value?.toLowerCase().split(/[-_]/)[0];
    if (languages.includes(language)) return language;
  }
  return 'en';
}
if (location.pathname === '/') {
  const preferred = match([read('blincho-site-language'), ...(navigator.languages || []), navigator.language]);
  location.replace(`/${preferred}/${location.search}${location.hash}`);
}
const select = document.querySelector('#language-select');
if (select) {
  select.value = document.documentElement.lang.split('-')[0];
  select.addEventListener('change', () => {
    if (!languages.includes(select.value)) return;
    save('blincho-site-language', select.value);
    location.assign(`/${select.value}/${location.search}${location.hash}`);
  });
}
const themeButton = document.querySelector('#theme-toggle');
const themes = ['system', 'light', 'dark'];
let theme = themes.includes(read('blincho-site-theme')) ? read('blincho-site-theme') : 'system';
function applyTheme() {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  if (themeButton) {
    const label = themeButton.dataset[theme];
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
    themeButton.dataset.mode = theme;
    themeButton.removeAttribute('aria-pressed');
  }
}
applyTheme();
themeButton?.addEventListener('click', () => {
  theme = themes[(themes.indexOf(theme) + 1) % themes.length];
  save('blincho-site-theme', theme);
  applyTheme();
});
