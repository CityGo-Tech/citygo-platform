function textEditorInside(container: HTMLElement) {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || !container.contains(element)) return;
  if (
    element.isContentEditable ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      ["text", "email", "tel", "url", "search", "number", "password"].includes(
        element.type,
      ))
  ) {
    return element;
  }
}

export function trackMiniAppKeyboard(shell: HTMLElement) {
  const viewport = window.visualViewport;
  if (!viewport) return;

  let baselineWidth = 0;
  let baselineHeight = 0;
  let pendingFrame = 0;

  const clearKeyboard = () => {
    shell.removeAttribute("data-mini-keyboard");
    shell.style.removeProperty("--mini-keyboard-height");
  };

  const update = () => {
    // Layout resizing varies by WebView. Compare the visual height with both
    // the layout viewport and the height observed before editing at this width.
    if (viewport.scale !== 1) {
      clearKeyboard();
      return;
    }
    const editor = textEditorInside(shell);
    if (window.innerWidth !== baselineWidth) {
      baselineWidth = window.innerWidth;
      baselineHeight = window.innerHeight;
    }
    if (!editor) baselineHeight = Math.max(baselineHeight, viewport.height);

    const fullHeight = Math.max(window.innerHeight, baselineHeight);
    if (!editor || fullHeight - viewport.height < 120) {
      clearKeyboard();
      return;
    }

    shell.setAttribute("data-mini-keyboard", "open");
    shell.style.setProperty("--mini-keyboard-height", `${viewport.height}px`);
    if (
      editor.getBoundingClientRect().bottom >
      shell.getBoundingClientRect().bottom
    ) {
      editor.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const scheduleUpdate = () => {
    window.cancelAnimationFrame(pendingFrame);
    pendingFrame = window.requestAnimationFrame(update);
  };

  update();
  viewport.addEventListener("resize", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  shell.addEventListener("focusin", scheduleUpdate);
  shell.addEventListener("focusout", scheduleUpdate);
  return () => {
    viewport.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    shell.removeEventListener("focusin", scheduleUpdate);
    shell.removeEventListener("focusout", scheduleUpdate);
    window.cancelAnimationFrame(pendingFrame);
    clearKeyboard();
  };
}
