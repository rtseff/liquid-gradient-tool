export const PRESETS = [
  { name: 'Aurora Teal', colors: ['#04120f', '#022a22', '#0bbf96', '#8bf5d6'] },
  { name: 'Deep Ocean', colors: ['#020617', '#0b3d91', '#38bdf8', '#e0f2fe'] },
  { name: 'Violet Dream', colors: ['#0b0014', '#3b0764', '#a855f7', '#f0abfc'] },
  { name: 'Sunset Ember', colors: ['#1a0505', '#7c2d12', '#f97316', '#fde68a'] },
  { name: 'Mono Noir', colors: ['#000000', '#1c1c1c', '#4b4b4b', '#e5e5e5'] },
  { name: 'Emerald Ink', colors: ['#00110c', '#014d40', '#10b981', '#d1fae5'] },
];

export function presetGradientCss(colors) {
  return `linear-gradient(135deg, ${colors.join(', ')})`;
}
