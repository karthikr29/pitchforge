import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Animated, StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getPalette, Palette, ThemeChoice, ThemeName } from "../constants/Colors";

type ThemeContextValue = {
  theme: ThemeName;
  choice: ThemeChoice;
  colors: Palette;
  setChoice: (choice: ThemeChoice) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "themePreference";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>("light");
  const fade = useRef(new Animated.Value(0)).current;
  const prevColorsRef = useRef<Palette>();
  const [overlayColors, setOverlayColors] = useState<Palette | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored === "light" || stored === "dark") {
          setChoiceState(stored);
        }
      } catch {
        // ignore storage read errors
      }
    };
    load();
  }, []);

  const setChoice = async (next: ThemeChoice) => {
    setChoiceState(next);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage write errors
    }
  };

  const theme: ThemeName = choice === "dark" ? "dark" : "light";
  const colors = useMemo(() => getPalette(theme), [theme]);

  useEffect(() => {
    if (!prevColorsRef.current) {
      prevColorsRef.current = colors;
      return;
    }
    const previous = prevColorsRef.current;
    if (previous === colors) return;
    setOverlayColors(previous);
    fade.setValue(1);
    Animated.timing(fade, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true
    }).start(() => {
      prevColorsRef.current = colors;
      setOverlayColors(null);
    });
    prevColorsRef.current = colors;
  }, [colors, fade]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      choice,
      colors,
      setChoice
    }),
    [theme, choice, colors]
  );

  return (
    <ThemeContext.Provider value={value}>
      <Animated.View style={[styles.container, { backgroundColor: colors.background }]}>
        {children}
        {overlayColors && (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFillObject,
              { backgroundColor: overlayColors.background, opacity: fade }
            ]}
          />
        )}
      </Animated.View>
    </ThemeContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }
});

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

