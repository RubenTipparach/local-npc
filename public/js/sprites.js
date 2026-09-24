// 16x16 characters drawn from a few colors and options, so a villager's look lives in its agent.md.

const DARK = "#2a2230";

export function drawCharacter(ctx, look, x, y, dir, step = 0) {
  const s = look.size === "small" ? 1 : 0; // kids are drawn a pixel shorter
  const p = (c, px, py, w = 1, h = 1) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + px, y + py + s, w, h);
  };
  const bob = step % 2 ? 1 : 0;

  // shadow
  ctx.fillStyle = "rgba(0,0,0,.22)";
  ctx.fillRect(x + 3, y + 14, 10, 2);

  // legs
  const legA = step === 1 ? 1 : 0, legB = step === 3 ? 1 : 0;
  p(look.pants, 5, 11, 2, 4 - legA);
  p(look.pants, 9, 11, 2, 4 - legB);
  p(DARK, 5, 15 - legA, 2, 1);
  p(DARK, 9, 15 - legB, 2, 1);

  // body and arms
  p(look.shirt, 4, 7 + bob, 8, 5);
  p(shade(look.shirt), 4, 11 + bob, 8, 1);
  if (dir === "left" || dir === "right") {
    p(shade(look.shirt), dir === "left" ? 7 : 8, 8 + bob, 2, 3);
    p(look.skin, dir === "left" ? 7 : 8, 11 + bob, 2, 1);
  } else {
    p(look.shirt, 3, 8 + bob, 1, 3);
    p(look.shirt, 12, 8 + bob, 1, 3);
    p(look.skin, 3, 11 + bob, 1, 1);
    p(look.skin, 12, 11 + bob, 1, 1);
  }

  // head
  p(look.skin, 4, 1 + bob, 8, 7);
  const hair = look.hair;
  if (dir === "up") {
    p(hair, 4, 0 + bob, 8, 7);
  } else {
    p(hair, 4, 0 + bob, 8, 2);
    if (dir === "left") p(hair, 8, 0 + bob, 4, 5);
    else if (dir === "right") p(hair, 4, 0 + bob, 4, 5);
    else { p(hair, 4, 2 + bob, 1, 3); p(hair, 11, 2 + bob, 1, 3); }
    // eyes
    if (dir === "down") { p(DARK, 6, 4 + bob, 1, 2); p(DARK, 9, 4 + bob, 1, 2); }
    if (dir === "left") p(DARK, 5, 4 + bob, 1, 2);
    if (dir === "right") p(DARK, 10, 4 + bob, 1, 2);
    if (look.accessory === "glasses" && dir !== "up") {
      if (dir === "down") { p("#dfe7ef", 5, 4 + bob, 3, 1); p("#dfe7ef", 8, 4 + bob, 3, 1); p(DARK, 6, 4 + bob, 1, 1); p(DARK, 9, 4 + bob, 1, 1); }
      else p("#dfe7ef", dir === "left" ? 4 : 9, 4 + bob, 3, 1);
    }
    if (look.accessory === "beard") {
      if (dir === "down") p(hair, 5, 6 + bob, 6, 2);
      else p(hair, dir === "left" ? 4 : 7, 6 + bob, 5, 2);
    }
  }

  // hats
  if (look.hat === "straw") { p("#e2c46a", 2, 0 + bob, 12, 2); p("#c9a64a", 4, -2 + bob, 8, 2); }
  if (look.hat === "cap") { p(shade(look.shirt), 4, -1 + bob, 8, 2); if (dir !== "up") p(shade(look.shirt), dir === "left" ? 2 : dir === "right" ? 10 : 4, 1 + bob, 4, 1); }
  if (look.hat === "bonnet") { p("#f7f3ea", 3, -1 + bob, 10, 3); p("#e6dccb", 3, 1 + bob, 1, 4); p("#e6dccb", 12, 1 + bob, 1, 4); }
}

function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.round(v * 0.75));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export function drawPortrait(canvas, look) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = canvas.width / 16;
  ctx.save();
  ctx.scale(scale, scale);
  drawCharacter(ctx, look, 0, 2, "down", 0);
  ctx.restore();
}
