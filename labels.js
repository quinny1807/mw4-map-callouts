// Pick a screen-side for each callout label so nearby pins do not stack
// on the same edge. Coordinates are fractions of the image, 0–1.

const NEAR = 0.08;

export function choosePlacements(pins) {
  const sorted = [...pins].sort((a, b) => {
    const created = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    if (created !== 0) return created;
    return String(a.id).localeCompare(String(b.id));
  });

  const chosen = new Map();
  for (const pin of sorted) {
    const used = new Set();
    for (const other of sorted) {
      if (other === pin || !chosen.has(other.id)) continue;
      const distance = Math.hypot(other.x - pin.x, other.y - pin.y);
      if (distance < NEAR) used.add(chosen.get(other.id));
    }

    let order;
    if (pin.y < 0.14) order = ["bottom", "right", "left", "top"];
    else if (pin.y > 0.86) order = ["top", "right", "left", "bottom"];
    else if (pin.x > 0.82) order = ["left", "top", "bottom", "right"];
    else if (pin.x < 0.18) order = ["right", "top", "bottom", "left"];
    else order = ["top", "bottom", "right", "left"];

    const place = order.find((item) => !used.has(item)) || order[0];
    chosen.set(pin.id, place);
  }
  return chosen;
}

// In a cluster, the callout with more votes than its neighbors leads.
// Ties stay even. Lone pins are left alone.
export function emphasisFor(pins, countOf) {
  const lead = new Set();
  const quiet = new Set();
  for (const pin of pins) {
    let bestOther = null;
    for (const other of pins) {
      if (other === pin) continue;
      if (Math.hypot(other.x - pin.x, other.y - pin.y) >= NEAR) continue;
      const votes = countOf(other);
      if (bestOther === null || votes > bestOther) bestOther = votes;
    }
    if (bestOther === null) continue;
    const mine = countOf(pin);
    if (mine > bestOther) lead.add(pin.id);
    else if (mine < bestOther) quiet.add(pin.id);
  }
  return { lead, quiet };
}

export function compareByVotes(a, b, countOf) {
  const diff = countOf(b) - countOf(a);
  if (diff !== 0) return diff;
  const name = String(a.name || "").localeCompare(String(b.name || ""));
  if (name !== 0) return name;
  return String(a.id).localeCompare(String(b.id));
}
