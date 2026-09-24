// The town map: built from rectangles, then pre-rendered once as 16px pixel-art tiles.

export const TILE = 16;
export const W = 40;
export const H = 30;

// Tile codes
const GRASS = ".", PATH = "=", TREE = "T", WATER = "~", BRIDGE = "b", FLOWER = "f",
  FENCE = "#", SOIL = "s", CROP = "c", DOOR = "D", TOWER = "P", SIGN = "n";

export const BUILDINGS = {
  H: { name: "Town Hall", roof: "#8c3b3b", roofDark: "#6e2c2c", wall: "#efe3c8", icon: "flag", door: "The Town Hall. Mayor Hilda is usually out front on the steps." },
  K: { name: "Crumb's Bakery", roof: "#d08a3c", roofDark: "#a86a28", wall: "#f6ead2", icon: "bread", door: "Crumb's Bakery. It smells like cinnamon. Maribel is outside." },
  S: { name: "Ashby's Smithy", roof: "#4b4f58", roofDark: "#363941", wall: "#b9ada0", icon: "anvil", door: "Ashby's Smithy. The forge inside is still warm." },
  G: { name: "Pennywhistle's General Store", roof: "#3d7a5a", roofDark: "#2d5c44", wall: "#efe3c8", icon: "sack", door: "Pennywhistle's General Store. A sign reads: SEEDS, ROPE, OIL. ASK TULLY." },
  L: { name: "Library", roof: "#35507a", roofDark: "#273b5a", wall: "#e4dccb", icon: "book", door: "The Library. The shelves are stacked to the ceiling with town records." },
  M: { name: "Old Mill", roof: "#5c4a3a", roofDark: "#44372b", wall: "#9c9488", icon: "mill", door: "The old mill door is chained shut. It has been empty for years, but there are fresh footprints in the dust." },
};

const SIGNS = {
  "22,9": "BRAMBLEWICK TOWN HALL. Harvest Festival in 3 days!",
  "33,12": "EAST: Hollis Farm. (That's yours now.)",
  "21,11": "HARVEST BELL. Cast 1823. Please do not climb the tower.",
};

export const grid = Array.from({ length: H }, () => Array(W).fill(GRASS));
const rect = (x, y, w, h, ch) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (grid[j]?.[i] !== undefined) grid[j][i] = ch;
};

// Terrain
rect(0, 0, W, 2, TREE);
rect(0, H - 1, W, 1, TREE);
rect(0, 0, 2, H, TREE);
rect(37, 0, 3, H, TREE);
rect(35, 0, 2, H, WATER);
// Roads
rect(2, 13, 33, 2, PATH);
rect(35, 13, 2, 2, BRIDGE);
rect(37, 13, 3, 2, PATH);
rect(15, 10, 10, 8, PATH); // plaza
rect(19, 8, 2, 16, PATH);
rect(3, 23, 30, 1, PATH);
rect(6, 9, 1, 4, PATH);
rect(31, 9, 1, 4, PATH);
rect(7, 22, 1, 1, PATH);
rect(31, 22, 1, 1, PATH);
rect(29, 24, 1, 5, PATH);
rect(26, 28, 3, 1, PATH);
// Buildings (letter = building id), doors on the front face
rect(16, 3, 8, 5, "H"); rect(19, 7, 2, 1, DOOR);
rect(4, 5, 6, 4, "K"); rect(6, 8, 1, 1, DOOR);
rect(29, 5, 6, 4, "S"); rect(31, 8, 1, 1, DOOR);
rect(4, 18, 7, 4, "G"); rect(7, 21, 1, 1, DOOR);
rect(28, 18, 7, 4, "L"); rect(31, 21, 1, 1, DOOR);
rect(24, 25, 5, 3, "M"); rect(26, 27, 1, 1, DOOR);
rect(19, 12, 2, 2, TOWER);
// Rosa's field
rect(2, 24, 13, 1, FENCE); rect(7, 24, 1, 1, PATH);
rect(14, 24, 1, 5, FENCE); rect(2, 28, 13, 1, FENCE);
rect(3, 25, 11, 3, SOIL);
for (const x of [3, 4, 5, 9, 10, 11, 12, 13]) { grid[25][x] = CROP; grid[27][x] = CROP; }
// Signs
for (const k of Object.keys(SIGNS)) { const [x, y] = k.split(",").map(Number); grid[y][x] = SIGN; }

// Decoration: seeded so the town looks the same every visit.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const keepClear = new Set(["18,9", "8,9", "33,9", "34,10", "9,22", "33,22", "16,16", "8,26", "20,17", "21,16"]);
for (let y = 2; y < H - 1; y++) {
  for (let x = 2; x < 35; x++) {
    if (grid[y][x] !== GRASS || keepClear.has(`${x},${y}`)) continue;
    const nearPath = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => grid[y + dy]?.[x + dx] !== GRASS && grid[y + dy]?.[x + dx] !== FLOWER && grid[y + dy]?.[x + dx] !== TREE);
    const r = rand();
    if (!nearPath && r < 0.07) grid[y][x] = TREE;
    else if (r > 0.93) grid[y][x] = FLOWER;
  }
}

const BLOCKING = new Set([TREE, WATER, FENCE, CROP, DOOR, TOWER, SIGN, ...Object.keys(BUILDINGS)]);

export function walkable(x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return !BLOCKING.has(grid[y][x]);
}

// What the player sees when pressing E at a non-NPC tile, or null.
export function inspect(x, y) {
  const t = grid[y]?.[x];
  if (t === SIGN) return SIGNS[`${x},${y}`];
  if (t === TOWER) return "The bell tower. The Harvest Bell hangs at the top, polished for the festival.";
  if (t === DOOR) {
    const above = grid[y - 1]?.[x];
    return BUILDINGS[above]?.door ?? null;
  }
  if (t === WATER) return "The river runs cold and clear.";
  if (t === CROP) return "Turnips, nearly ready to harvest. Rosa takes good care of these.";
  return null;
}

// ---- rendering -------------------------------------------------------------------------------

const hash = (x, y, k = 0) => {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

function px(ctx, color, x, y, w = 1, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawGrass(ctx, ox, oy, x, y) {
  px(ctx, (x + y) % 2 ? "#7cc25e" : "#78be5a", ox, oy, TILE, TILE);
  for (let i = 0; i < 5; i++) {
    const sx = Math.floor(hash(x, y, i) * 15), sy = Math.floor(hash(x, y, i + 9) * 14);
    px(ctx, "#5fa447", ox + sx, oy + sy, 1, 2);
  }
}

function drawPath(ctx, ox, oy, x, y) {
  px(ctx, "#dcc08a", ox, oy, TILE, TILE);
  for (let i = 0; i < 4; i++) px(ctx, "#c9a970", ox + Math.floor(hash(x, y, i) * 15), oy + Math.floor(hash(x, y, i + 5) * 15), 2, 1);
  const edge = (dx, dy) => { const t = grid[y + dy]?.[x + dx]; return t === GRASS || t === FLOWER || t === TREE; };
  if (edge(0, -1)) px(ctx, "#b99b62", ox, oy, TILE, 1);
  if (edge(0, 1)) px(ctx, "#b99b62", ox, oy + 15, TILE, 1);
  if (edge(-1, 0)) px(ctx, "#b99b62", ox, oy, 1, TILE);
  if (edge(1, 0)) px(ctx, "#b99b62", ox + 15, oy, 1, TILE);
}

function drawTree(ctx, ox, oy) {
  px(ctx, "#6b4a2b", ox + 6, oy + 10, 4, 5);
  px(ctx, "#2f6d3a", ox + 1, oy + 2, 14, 9);
  px(ctx, "#2f6d3a", ox + 3, oy, 10, 13);
  px(ctx, "#3f8a48", ox + 3, oy + 2, 8, 6);
  px(ctx, "#56a65a", ox + 4, oy + 3, 4, 3);
  px(ctx, "rgba(0,0,0,.18)", ox + 2, oy + 14, 12, 2);
}

function drawFence(ctx, ox, oy, x, y) {
  const horiz = grid[y][x - 1] === FENCE || grid[y][x + 1] === FENCE;
  if (horiz) {
    px(ctx, "#9b6b3e", ox, oy + 6, TILE, 2);
    px(ctx, "#9b6b3e", ox, oy + 10, TILE, 2);
    px(ctx, "#7a522d", ox + 6, oy + 4, 3, 10);
  } else {
    px(ctx, "#9b6b3e", ox + 6, oy, 3, TILE);
    px(ctx, "#7a522d", ox + 5, oy + 6, 5, 3);
  }
}

function drawSoil(ctx, ox, oy) {
  px(ctx, "#8a5d3b", ox, oy, TILE, TILE);
  for (let r = 2; r < 16; r += 5) px(ctx, "#744b2e", ox, oy + r, TILE, 2);
}

function drawCrop(ctx, ox, oy, x, y) {
  drawSoil(ctx, ox, oy);
  px(ctx, "#f1ece0", ox + 5, oy + 8, 6, 5);
  px(ctx, "#b7659a", ox + 5, oy + 8, 6, 2);
  px(ctx, "#4f9a3c", ox + 6, oy + 3, 2, 5);
  px(ctx, "#63b24a", ox + 8, oy + 2, 2, 6);
  if (hash(x, y) > 0.5) px(ctx, "#4f9a3c", ox + 4, oy + 4, 2, 3);
}

function drawFlowers(ctx, ox, oy, x, y) {
  drawGrass(ctx, ox, oy, x, y);
  const colors = ["#f2d14b", "#f08aa8", "#ffffff", "#b88cf0"];
  for (let i = 0; i < 3; i++) {
    const fx = 2 + Math.floor(hash(x, y, i + 20) * 11), fy = 2 + Math.floor(hash(x, y, i + 30) * 11);
    const c = colors[Math.floor(hash(x, y, i + 40) * colors.length)];
    px(ctx, c, ox + fx - 1, oy + fy, 3, 1);
    px(ctx, c, ox + fx, oy + fy - 1, 1, 3);
    px(ctx, "#e0892c", ox + fx, oy + fy, 1, 1);
  }
}

function drawSign(ctx, ox, oy, x, y) {
  drawGrassOrPath(ctx, ox, oy, x, y);
  px(ctx, "#7a522d", ox + 7, oy + 8, 2, 7);
  px(ctx, "#b98a52", ox + 2, oy + 3, 12, 7);
  px(ctx, "#8a6236", ox + 2, oy + 9, 12, 1);
  px(ctx, "#6b4a2b", ox + 4, oy + 5, 8, 1);
  px(ctx, "#6b4a2b", ox + 4, oy + 7, 6, 1);
}

function drawGrassOrPath(ctx, ox, oy, x, y) {
  const around = [grid[y][x - 1], grid[y][x + 1], grid[y - 1]?.[x], grid[y + 1]?.[x]];
  if (around.filter((t) => t === PATH).length >= 2) drawPath(ctx, ox, oy, x, y);
  else drawGrass(ctx, ox, oy, x, y);
}

function drawBridge(ctx, ox, oy) {
  px(ctx, "#a8773f", ox, oy, TILE, TILE);
  for (let i = 0; i < 16; i += 4) px(ctx, "#8a5f30", ox + i, oy, 1, TILE);
  px(ctx, "#6b4a2b", ox, oy, TILE, 1);
  px(ctx, "#6b4a2b", ox, oy + 15, TILE, 1);
}

function drawIcon(ctx, icon, cx, cy) {
  // 8x6 pictogram on a hanging plaque centred at (cx, cy)
  px(ctx, "#6b4a2b", cx - 6, cy - 5, 12, 10);
  px(ctx, "#f3e6c4", cx - 5, cy - 4, 10, 8);
  const ink = "#5a3b22";
  if (icon === "bread") { px(ctx, "#c9832e", cx - 4, cy - 1, 8, 3); px(ctx, "#e0a24a", cx - 3, cy - 2, 6, 1); }
  if (icon === "anvil") { px(ctx, "#4b4f58", cx - 4, cy - 2, 8, 2); px(ctx, "#4b4f58", cx - 1, cy, 2, 2); px(ctx, "#4b4f58", cx - 3, cy + 2, 6, 1); }
  if (icon === "book") { px(ctx, "#35507a", cx - 4, cy - 3, 4, 6); px(ctx, "#8c3b3b", cx, cy - 3, 4, 6); px(ctx, ink, cx - 0.5, cy - 3, 1, 6); }
  if (icon === "sack") { px(ctx, "#b98a52", cx - 3, cy - 1, 6, 4); px(ctx, "#8a6236", cx - 1, cy - 3, 2, 2); }
  if (icon === "flag") { px(ctx, ink, cx - 3, cy - 3, 1, 7); px(ctx, "#8c3b3b", cx - 2, cy - 3, 5, 3); }
  if (icon === "mill") { px(ctx, ink, cx - 4, cy - 3, 8, 1); px(ctx, ink, cx - 0.5, cy - 4, 1, 8); }
}

function drawBuilding(ctx, id, bx, by, bw, bh) {
  const b = BUILDINGS[id];
  const x0 = bx * TILE, y0 = by * TILE, w = bw * TILE, h = bh * TILE;
  const roofH = Math.max(TILE, (bh - 1.5) * TILE) | 0;
  // walls
  px(ctx, b.wall, x0 + 2, y0 + roofH - 4, w - 4, h - roofH + 4);
  px(ctx, "rgba(0,0,0,.12)", x0 + 2, y0 + h - 2, w - 4, 2);
  // windows
  for (let wx = x0 + 10; wx < x0 + w - 14; wx += 22) {
    if (Math.abs(wx + 5 - (x0 + w / 2)) < 12) continue;
    px(ctx, "#5a4632", wx - 1, y0 + roofH + 1, 12, 11);
    px(ctx, "#9fd3e8", wx, y0 + roofH + 2, 10, 9);
    px(ctx, "#5a4632", wx + 4, y0 + roofH + 2, 1, 9);
    px(ctx, "#d7f0f8", wx + 1, y0 + roofH + 3, 2, 2);
  }
  // roof with shingles and overhang
  px(ctx, b.roofDark, x0, y0 + roofH - 5, w, 3);
  px(ctx, b.roof, x0, y0, w, roofH - 5);
  for (let r = y0 + 4; r < y0 + roofH - 6; r += 4) {
    const off = ((r - y0) / 4) % 2 ? 0 : 4;
    for (let c = x0 + off; c < x0 + w; c += 8) px(ctx, b.roofDark, c, r, 1, 3);
    px(ctx, b.roofDark, x0, r + 3, w, 1);
  }
  px(ctx, "rgba(255,255,255,.18)", x0, y0, w, 2);
  if (id === "M") {
    // windmill sails on the roof
    const cx = x0 + w / 2, cy = y0 + roofH / 2 - 2;
    ctx.fillStyle = "#d8cbb0";
    ctx.fillRect(cx - 1, cy - 12, 2, 24);
    ctx.fillRect(cx - 12, cy - 1, 24, 2);
    px(ctx, "#5a4632", cx - 2, cy - 2, 4, 4);
  }
  drawIcon(ctx, b.icon, x0 + w / 2 + (id === "H" ? 0 : 18), y0 + roofH - 10);
}

function drawDoor(ctx, ox, oy, x, y) {
  px(ctx, BUILDINGS[grid[y - 1][x]].wall, ox, oy, TILE, TILE);
  px(ctx, "#5a3b22", ox + 2, oy + 1, 12, 15);
  px(ctx, "#7a522d", ox + 3, oy + 2, 10, 14);
  px(ctx, "#e6c35a", ox + 10, oy + 9, 2, 2);
  if (grid[y - 1][x] === "M") {
    px(ctx, "#8a8f98", ox + 3, oy + 7, 10, 1);
    px(ctx, "#8a8f98", ox + 3, oy + 10, 10, 1);
  }
}

function drawTower(ctx) {
  const x0 = 19 * TILE, y0 = 12 * TILE;
  px(ctx, "#8f8a82", x0 + 4, y0 + 6, 24, 26);
  for (let r = y0 + 10; r < y0 + 32; r += 5) px(ctx, "#77726b", x0 + 4, r, 24, 1);
  px(ctx, "#5a4632", x0 + 2, y0 - 14, 3, 22);
  px(ctx, "#5a4632", x0 + 27, y0 - 14, 3, 22);
  px(ctx, "#6b4a2b", x0, y0 - 16, 32, 4);
  // the Harvest Bell
  px(ctx, "#3a3a3a", x0 + 15, y0 - 12, 2, 2);
  px(ctx, "#c9a13a", x0 + 11, y0 - 10, 10, 7);
  px(ctx, "#c9a13a", x0 + 9, y0 - 4, 14, 3);
  px(ctx, "#e8c96a", x0 + 13, y0 - 9, 2, 5);
  px(ctx, "#8a6a1e", x0 + 15, y0 - 1, 2, 2);
  px(ctx, "rgba(0,0,0,.2)", x0 + 4, y0 + 30, 24, 2);
}

export function renderStatic() {
  const c = document.createElement("canvas");
  c.width = W * TILE;
  c.height = H * TILE;
  const ctx = c.getContext("2d");
  const seen = new Set();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = grid[y][x], ox = x * TILE, oy = y * TILE;
      if (t === PATH) drawPath(ctx, ox, oy, x, y);
      else if (t === WATER) px(ctx, "#4a8fd4", ox, oy, TILE, TILE);
      else if (t === BRIDGE) drawBridge(ctx, ox, oy);
      else if (t === SOIL) drawSoil(ctx, ox, oy);
      else if (t === CROP) drawCrop(ctx, ox, oy, x, y);
      else if (t === FLOWER) drawFlowers(ctx, ox, oy, x, y);
      else if (t === TOWER) drawPath(ctx, ox, oy, x, y);
      else if (t === SIGN) drawSign(ctx, ox, oy, x, y);
      else drawGrass(ctx, ox, oy, x, y);
      if (t === FENCE) drawFence(ctx, ox, oy, x, y);
    }
  }
  // Multi-tile objects after the ground so they can overlap neighbouring tiles.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = grid[y][x];
      if (BUILDINGS[t] && !seen.has(t)) {
        seen.add(t);
        let bw = 0, bh = 0;
        while (grid[y][x + bw] === t || grid[y][x + bw] === DOOR) bw++;
        while (grid[y + bh]?.[x] === t || grid[y + bh]?.[x] === DOOR) bh++;
        drawBuilding(ctx, t, x, y, bw, bh);
      }
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (grid[y][x] === DOOR) drawDoor(ctx, x * TILE, y * TILE, x, y);
  drawTower(ctx);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (grid[y][x] === TREE) drawTree(ctx, x * TILE, y * TILE);
  return c;
}

// Water shimmer drawn each frame over the static map.
export function drawWater(ctx, t, view) {
  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      if (grid[y]?.[x] !== WATER) continue;
      const ox = x * TILE, oy = y * TILE;
      const phase = Math.floor(t / 400 + hash(x, y) * 4) % 4;
      ctx.fillStyle = "#79b6ea";
      ctx.fillRect(ox + 2 + phase * 2, oy + 4 + ((x + y) % 3) * 3, 5, 1);
      ctx.fillRect(ox + 9 - phase, oy + 11, 4, 1);
    }
  }
}
