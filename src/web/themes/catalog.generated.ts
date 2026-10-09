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
  },
  "omarchy": {
    "name": "Omarchy",
    "colorScheme": "dark"
  },
  "matrix": {
    "name": "Matrix",
    "colorScheme": "dark"
  },
  "black-contrast": {
    "name": "Black Contrast",
    "colorScheme": "dark"
  },
  "white-contrast": {
    "name": "White Contrast",
    "colorScheme": "light"
  },
  "catppuccin-mocha": {
    "name": "Catppuccin Mocha",
    "colorScheme": "dark"
  }
} as const;
export type Theme = keyof typeof THEME_DEFINITIONS;
