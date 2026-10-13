import type { ITheme } from "@xterm/xterm";

export type ThemeName = "dark" | "light";
export function isTheme(value: unknown): value is ThemeName {
  return value === "dark" || value === "light";
}

const DARK_TERMINAL_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const LIGHT_TERMINAL_THEME = {
  background: '#ffffff', foreground: '#24292f',
  cursor: '#24292f', cursorAccent: '#ffffff',
  selectionBackground: '#b6d7ff',
  black: '#24292f', red: '#b42318', green: '#176b35',
  yellow: '#856000', blue: '#1756a9', magenta: '#8335a3',
  cyan: '#006b75', white: '#707780',
  brightBlack: '#59636e', brightRed: '#cf222e', brightGreen: '#238636',
  brightYellow: '#946800', brightBlue: '#0969da', brightMagenta: '#a03db0',
  brightCyan: '#087e8b', brightWhite: '#858b93',
};

export const TERMINAL_THEMES: Record<ThemeName, ITheme> = { dark: DARK_TERMINAL_THEME, light: LIGHT_TERMINAL_THEME };

export function applyDocumentTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.documentElement.style.setProperty("--terminal-background", TERMINAL_THEMES[theme].background!);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f5f6f8" : "#1e1e1e");
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
}
