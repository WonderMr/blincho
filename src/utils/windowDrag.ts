const INTERACTIVE_SELECTOR = [
  'button', 'input', 'select', 'textarea', 'option', 'optgroup', 'a', 'label', 'summary',
  'iframe', 'object', 'embed', 'audio', 'video', '[tabindex]', '[contenteditable]', '[draggable="true"]',
  '[aria-disabled="true"]', '.no-drag', '[data-no-drag]',
  ...['button', 'link', 'checkbox', 'radio', 'tab', 'switch', 'slider', 'spinbutton', 'textbox',
    'searchbox', 'combobox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'scrollbar', 'treeitem']
    .map(role => `[role="${role}"]`),
].join(',');
const OVERLAY_SELECTOR = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal-backdrop,.exercise-modal-overlay,.fullscreen-break-takeover,.app-toast';
// Matches the global WebKit scrollbar width/height in index.css, including
// macOS overlay scrollbars, whose gutter is absent from clientWidth/clientHeight.
const OVERLAY_SCROLLBAR_GUTTER = 8;
const TEXT_NODE = 3;
const SHOW_TEXT = 4;

function containsPoint(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isScrollbarPress(target: Element, event: MouseEvent, view: Window): boolean {
  for (let element: Element | null = target; element; element = element.parentElement) {
    const box = element as HTMLElement;
    if (!box.offsetWidth || !box.offsetHeight) continue;
    const rootScroller = box === box.ownerDocument.documentElement || box === box.ownerDocument.scrollingElement;
    const rect = rootScroller ? { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight,
      width: view.innerWidth, height: view.innerHeight } : box.getBoundingClientRect();
    if (!containsPoint(rect, event.clientX, event.clientY)) continue;
    const style = view.getComputedStyle(box);
    const scrolls = (overflow: string, contentSize: number, clientSize: number) => overflow === 'scroll' ||
      (contentSize > clientSize && (overflow === 'auto' || overflow === 'overlay' || (rootScroller && overflow !== 'hidden' && overflow !== 'clip')));
    const scaleX = rootScroller ? 1 : rect.width / box.offsetWidth;
    const scaleY = rootScroller ? 1 : rect.height / box.offsetHeight;
    const left = rect.left + box.clientLeft * scaleX;
    const top = rect.top + box.clientTop * scaleY;
    const right = left + box.clientWidth * scaleX;
    const bottom = top + box.clientHeight * scaleY;
    if (scrolls(style.overflowY, box.scrollHeight, box.clientHeight)) {
      const overlayEdge = style.direction === 'rtl' ? event.clientX < left + OVERLAY_SCROLLBAR_GUTTER * scaleX :
        event.clientX >= right - OVERLAY_SCROLLBAR_GUTTER * scaleX;
      if (event.clientX < left || event.clientX >= right || overlayEdge) return true;
    }
    if (scrolls(style.overflowX, box.scrollWidth, box.clientWidth) &&
      (event.clientY < top || event.clientY >= bottom - OVERLAY_SCROLLBAR_GUTTER * scaleY)) return true;
  }
  return false;
}

function isSelectableTextPress(target: Element, event: MouseEvent, view: Window): boolean {
  const document = target.ownerDocument;
  const walker = document.createTreeWalker(target, SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || !node.parentElement || view.getComputedStyle(node.parentElement).userSelect === 'none') continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (containsPoint(rect, event.clientX, event.clientY)) return true;
    }
  }
  return false;
}

export function shouldStartWindowDrag(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const node = event.target as Node | null;
  const target = node?.nodeType === TEXT_NODE ? node.parentElement : node?.nodeType === 1 ? node as Element : null;
  if (!target?.closest('.app-container,.mac-titlebar-drag')) return false;
  if (target.closest(INTERACTIVE_SELECTOR) || target.closest(OVERLAY_SELECTOR)) return false;
  const document = target.ownerDocument;
  const view = document.defaultView;
  if (!view || document.getSelection()?.isCollapsed === false) return false;
  const cursor = view.getComputedStyle(target).cursor;
  if (['pointer', 'text', 'vertical-text', 'grab', 'grabbing', 'not-allowed'].includes(cursor)) return false;
  if (isScrollbarPress(target, event, view)) return false;
  // The existing titlebar title is part of its drag region. App content keeps
  // text selection, with only padding and other empty rectangles draggable.
  return !!target.closest('.mac-titlebar-drag') || !isSelectableTextPress(target, event, view);
}

export function installWindowDrag(document: Document, startDragging: () => Promise<void>,
  onError: (error: unknown) => void = error => console.warn('Blincho: Drag failed:', error)): () => void {
  const onMouseDown = (event: MouseEvent) => {
    if (!shouldStartWindowDrag(event)) return;
    event.preventDefault();
    try { void startDragging().catch(onError); }
    catch (error) { onError(error); }
  };
  document.addEventListener('mousedown', onMouseDown);
  return () => document.removeEventListener('mousedown', onMouseDown);
}
