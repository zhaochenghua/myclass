let rotation = 0;

export function layoutPoint(point) {
  const x = point.clientX ?? point.x;
  const y = point.clientY ?? point.y;
  if (rotation === 90) return { x: y, y: window.innerWidth - x };
  if (rotation === -90) return { x: window.innerHeight - y, y: x };
  return { x, y };
}

export function layoutRect(element) {
  const rect = element.getBoundingClientRect();
  const a = layoutPoint({ x: rect.left, y: rect.top });
  const b = layoutPoint({ x: rect.right, y: rect.bottom });
  const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
  const width = Math.abs(b.x - a.x), height = Math.abs(b.y - a.y);
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

export function createOrientationLock({ root, read, save, onChange }) {
  const saved = read();
  let preference = ['auto', 'landscape', 'portrait'].includes(saved) ? saved : 'auto';
  let connected = false;
  function update() {
    const width = window.innerWidth, height = window.innerHeight;
    const physical = width > height ? 'landscape' : 'portrait';
    const selected = connected ? preference : 'auto';
    rotation = selected === 'auto' || selected === physical ? 0 : selected === 'landscape' ? 90 : -90;
    root.style.width = `${rotation ? height : width}px`;
    root.style.height = `${rotation ? width : height}px`;
    root.style.transform = rotation === 90 ? `translateX(${width}px) rotate(90deg)` :
      rotation === -90 ? `translateY(${height}px) rotate(-90deg)` : 'none';
    const sides = rotation === 90 ? ['right', 'bottom', 'left', 'top'] :
      rotation === -90 ? ['left', 'top', 'right', 'bottom'] : ['top', 'right', 'bottom', 'left'];
    ['top', 'right', 'bottom', 'left'].forEach((side, index) =>
      root.style.setProperty(`--safe-${side}`, `env(safe-area-inset-${sides[index]}, 0px)`));
    root.dataset.orientation = selected === 'auto' ? physical : selected;
    document.querySelectorAll('[data-screen-orientation]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.screenOrientation === preference));
    });
    onChange?.();
  }
  window.addEventListener('resize', update);
  return {
    setConnected(value) { if (connected !== value) { connected = value; update(); } },
    select(value) {
      if (!['auto', 'landscape', 'portrait'].includes(value)) return;
      preference = value; save(value); update();
    },
    update
  };
}
