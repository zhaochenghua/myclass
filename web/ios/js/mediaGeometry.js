// Dimensions in screen axes, matching the classroom viewer's imageViewBaseSize.
export function mediaPreviewGeometry(width, height, boxWidth, boxHeight, naturalWidth, naturalHeight, rotation) {
  const swapped = rotation === 90 || rotation === 270;
  let refit = 1;
  if (swapped && naturalWidth > 0 && naturalHeight > 0 && boxWidth > 0 && boxHeight > 0) {
    const before = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    const after = Math.min(boxWidth / naturalHeight, boxHeight / naturalWidth);
    refit = after / before;
  }
  return { baseWidth: (swapped ? height : width) * refit,
    baseHeight: (swapped ? width : height) * refit, refit };
}
