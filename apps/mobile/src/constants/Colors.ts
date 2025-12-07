export type ThemeName = "light" | "dark";

export type Palette = {
  background: string;
  surface: string;
  primary: string;
  primaryText: string;
  textMain: string;
  textMuted: string;
  border: string;
  icon: string;
  error: string;
};

export const palette: Record<ThemeName, Palette> = {
  light: {
    background: "#F0F4F8",
    surface: "#FFFFFF",
    primary: "#EA580C",
    primaryText: "#FFFFFF",
    textMain: "#0F172A",
    textMuted: "#64748B",
    border: "#E2E8F0",
    icon: "#0F172A",
    error: "#DC2626"
  },
  dark: {
    background: "#0B1121",
    surface: "#151E32",
    primary: "#FB923C",
    primaryText: "#0F172A",
    textMain: "#F8FAFC",
    textMuted: "#94A3B8",
    border: "#1E293B",
    icon: "#F8FAFC",
    error: "#EF4444"
  }
};

export type ThemeChoice = ThemeName;

export const getPalette = (theme: ThemeName) => palette[theme];

