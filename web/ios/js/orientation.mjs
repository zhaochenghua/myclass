export function layoutPoint(point) {
  const x = point.clientX ?? point.x;
  const y = point.clientY ?? point.y;
  return { x, y };
}

// DOMRect 的几何属性挂在原型上，展开运算符拿不到，必须逐项复制。
export function layoutRect(element) {
  const rect = element.getBoundingClientRect();
  const { left, top, right, bottom, width, height } = rect;
  return { left, top, right, bottom, width, height, x: left, y: top };
}
