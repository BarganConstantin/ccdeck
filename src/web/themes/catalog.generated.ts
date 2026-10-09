// Generated from themes/*.json. Run npm run themes:generate; do not edit.
export const THEME_DEFINITIONS = {
  "light": {
    "name": "Light",
    "colorScheme": "light"
  },
  "dark": {
    "name": "Dark",
    "colorScheme": "dark"
  },
  "rider-black": {
    "name": "Rider Black",
    "colorScheme": "dark"
  },
  "vscode-black": {
    "name": "VS Code Black",
    "colorScheme": "dark"
  }
} as const;
export type Theme = keyof typeof THEME_DEFINITIONS;
