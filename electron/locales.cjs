// Native UI has its own bundled strings so it also works before the renderer loads.
const keys = ['title', 'show', 'breakNow', 'quit', 'about', 'hide', 'hideOthers', 'showAll', 'edit', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'window', 'minimize', 'zoom', 'front', 'notificationTitle', 'notificationBody'];
const translations = {
  en: ['Blincho: Screen breaks', 'Show Blincho', 'Take a break now', 'Quit', 'About Blincho', 'Hide Blincho', 'Hide Others', 'Show All', 'Edit', 'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All', 'Window', 'Minimize', 'Zoom', 'Bring All to Front', 'Blincho: Rest your eyes', 'Time for a 20-second eye break!'],
  ru: ['Blincho: Перерывы от экрана', 'Показать Blincho', 'Сделать перерыв сейчас', 'Выход', 'О Blincho', 'Скрыть Blincho', 'Скрыть остальные', 'Показать все', 'Правка', 'Отменить', 'Повторить', 'Вырезать', 'Копировать', 'Вставить', 'Выбрать всё', 'Окно', 'Свернуть', 'Масштаб', 'Все окна на передний план', 'Blincho: Отдых для глаз', 'Пора сделать 20-секундный перерыв для зрения!'],
  es: ['Blincho: Descansos de pantalla', 'Mostrar Blincho', 'Descansar ahora', 'Salir', 'Acerca de Blincho', 'Ocultar Blincho', 'Ocultar otras', 'Mostrar todo', 'Edición', 'Deshacer', 'Rehacer', 'Cortar', 'Copiar', 'Pegar', 'Seleccionar todo', 'Ventana', 'Minimizar', 'Zoom', 'Traer todo al frente', 'Blincho: Descansa la vista', '¡Es hora de descansar la vista durante 20 segundos!'],
  fr: ['Blincho: Pauses écran', 'Afficher Blincho', 'Faire une pause maintenant', 'Quitter', 'À propos de Blincho', 'Masquer Blincho', 'Masquer les autres', 'Tout afficher', 'Édition', 'Annuler', 'Rétablir', 'Couper', 'Copier', 'Coller', 'Tout sélectionner', 'Fenêtre', 'Réduire', 'Zoom', 'Tout ramener au premier plan', 'Blincho: Reposez vos yeux', 'Il est temps de faire une pause visuelle de 20 secondes !'],
  de: ['Blincho: Bildschirmpausen', 'Blincho anzeigen', 'Jetzt eine Pause machen', 'Beenden', 'Über Blincho', 'Blincho ausblenden', 'Andere ausblenden', 'Alle einblenden', 'Bearbeiten', 'Widerrufen', 'Wiederholen', 'Ausschneiden', 'Kopieren', 'Einfügen', 'Alles auswählen', 'Fenster', 'Minimieren', 'Zoomen', 'Alle nach vorne bringen', 'Blincho: Augen entspannen', 'Zeit für eine 20-sekündige Augenpause!'],
  it: ['Blincho: Pause dallo schermo', 'Mostra Blincho', 'Fai una pausa ora', 'Esci', 'Informazioni su Blincho', 'Nascondi Blincho', 'Nascondi altre', 'Mostra tutto', 'Modifica', 'Annulla', 'Ripristina', 'Taglia', 'Copia', 'Incolla', 'Seleziona tutto', 'Finestra', 'Riduci a icona', 'Zoom', 'Porta tutto in primo piano', 'Blincho: Riposa gli occhi', 'È ora di una pausa di 20 secondi per gli occhi!'],
  pt: ['Blincho: Pausas da tela', 'Mostrar Blincho', 'Fazer uma pausa agora', 'Sair', 'Sobre o Blincho', 'Ocultar Blincho', 'Ocultar outros', 'Mostrar tudo', 'Editar', 'Desfazer', 'Refazer', 'Recortar', 'Copiar', 'Colar', 'Selecionar tudo', 'Janela', 'Minimizar', 'Zoom', 'Trazer todas para frente', 'Blincho: Descanse os olhos', 'Hora de uma pausa de 20 segundos para os olhos!'],
  zh: ['Blincho: 屏幕休息', '显示 Blincho', '立即休息', '退出', '关于 Blincho', '隐藏 Blincho', '隐藏其他', '全部显示', '编辑', '撤销', '重做', '剪切', '复制', '粘贴', '全选', '窗口', '最小化', '缩放', '全部置于前面', 'Blincho: 让眼睛休息', '该让眼睛休息 20 秒了！'],
  ja: ['Blincho: 画面から離れる休憩', 'Blincho を表示', '今すぐ休憩', '終了', 'Blincho について', 'Blincho を隠す', 'ほかを隠す', 'すべてを表示', '編集', '取り消す', 'やり直す', 'カット', 'コピー', 'ペースト', 'すべてを選択', 'ウインドウ', 'しまう', 'ズーム', 'すべてを手前に移動', 'Blincho: 目を休めましょう', '20秒間、目を休める時間です！'],
  ko: ['Blincho: 화면 휴식', 'Blincho 표시', '지금 휴식하기', '종료', 'Blincho 정보', 'Blincho 가리기', '기타 가리기', '모두 보기', '편집', '실행 취소', '다시 실행', '오려두기', '복사하기', '붙여넣기', '모두 선택', '윈도우', '최소화', '확대/축소', '모두 앞으로 가져오기', 'Blincho: 눈을 쉬게 하세요', '20초 동안 눈을 쉴 시간입니다!'],
  ar: ['Blincho: استراحات من الشاشة', 'إظهار Blincho', 'خذ استراحة الآن', 'إنهاء', 'حول Blincho', 'إخفاء Blincho', 'إخفاء الآخرين', 'إظهار الكل', 'تحرير', 'تراجع', 'إعادة', 'قص', 'نسخ', 'لصق', 'تحديد الكل', 'نافذة', 'تصغير', 'تكبير', 'إحضار الكل إلى المقدمة', 'Blincho: أرح عينيك', 'حان وقت استراحة للعينين لمدة 20 ثانية!'],
  hi: ['Blincho: स्क्रीन से विराम', 'Blincho दिखाएँ', 'अभी विराम लें', 'बंद करें', 'Blincho के बारे में', 'Blincho छिपाएँ', 'अन्य छिपाएँ', 'सभी दिखाएँ', 'संपादन', 'पूर्ववत करें', 'फिर से करें', 'काटें', 'कॉपी करें', 'चिपकाएँ', 'सभी चुनें', 'विंडो', 'छोटा करें', 'ज़ूम', 'सभी को सामने लाएँ', 'Blincho: आँखों को आराम दें', 'आँखों को 20 सेकंड का आराम देने का समय है!'],
  tr: ['Blincho: Ekran molaları', 'Blincho’yu göster', 'Şimdi mola ver', 'Çıkış', 'Blincho hakkında', 'Blincho’yu gizle', 'Diğerlerini gizle', 'Tümünü göster', 'Düzenle', 'Geri al', 'Yinele', 'Kes', 'Kopyala', 'Yapıştır', 'Tümünü seç', 'Pencere', 'Simge durumuna küçült', 'Büyüt', 'Tümünü öne getir', 'Blincho: Gözlerinizi dinlendirin', '20 saniyelik göz molası zamanı!'],
  pl: ['Blincho: Przerwy od ekranu', 'Pokaż Blincho', 'Zrób przerwę teraz', 'Zakończ', 'O Blincho', 'Ukryj Blincho', 'Ukryj pozostałe', 'Pokaż wszystko', 'Edycja', 'Cofnij', 'Ponów', 'Wytnij', 'Kopiuj', 'Wklej', 'Zaznacz wszystko', 'Okno', 'Minimalizuj', 'Powiększ', 'Przenieś wszystko na wierzch', 'Blincho: Daj oczom odpocząć', 'Czas na 20-sekundową przerwę dla oczu!'],
  uk: ['Blincho: Перерви від екрана', 'Показати Blincho', 'Зробити перерву зараз', 'Вихід', 'Про Blincho', 'Приховати Blincho', 'Приховати інші', 'Показати все', 'Редагування', 'Скасувати', 'Повторити', 'Вирізати', 'Копіювати', 'Вставити', 'Вибрати все', 'Вікно', 'Згорнути', 'Масштаб', 'Усі вікна на передній план', 'Blincho: Відпочинок для очей', 'Час зробити 20-секундну перерву для очей!'],
};
const locales = Object.freeze(Object.fromEntries(Object.entries(translations).map(([code, values]) =>
  [code, Object.freeze(Object.fromEntries(keys.map((key, index) => [key, values[index]])))])));

function isLocale(code) { return typeof code === 'string' && Object.prototype.hasOwnProperty.call(locales, code); }
function resolveLocale(preferences) {
  for (const value of preferences) {
    if (typeof value !== 'string') continue;
    const code = value.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(code)) return code;
  }
  return 'en';
}
module.exports = { locales, isLocale, resolveLocale };
