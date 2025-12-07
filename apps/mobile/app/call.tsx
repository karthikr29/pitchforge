import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { personas } from "../src/constants/personas";
import { useSessionStore } from "../src/state/useSessionStore";
import { useTheme } from "../src/context/ThemeContext";

export default function CallStartScreen() {
  const router = useRouter();
  const { personaId } = useSessionStore();
  const persona = personas.find((p) => p.id === personaId);
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  useEffect(() => {
    if (!personaId) {
      router.replace("/");
    }
  }, [personaId, router]);

  const handleStart = () => {
    router.push("/conversation");
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>Ready to call</Text>
        <Text style={styles.name}>{persona?.name}</Text>
      <Text style={styles.role}>{persona?.role}</Text>
        <Text style={styles.copy}>
          You will jump into a live conversation with {persona?.name}. Tap the button below and
          start speaking — we handle the rest.
          </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Tap to talk"
        disabled={!personaId}
        onPress={handleStart}
        style={[
          styles.cta,
          { opacity: personaId ? 1 : 0.4 }
        ]}
      >
        <Text style={styles.ctaText}>Tap to Talk</Text>
      </Pressable>

      <View style={styles.hint}>
        <Text style={styles.hintLabel}>What happens next?</Text>
        <Text style={styles.hintCopy}>
          We will open the conversation view with a clean transcript and an option to end whenever
          you are done.
            </Text>
      </View>
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: {
      flex: 1,
      padding: 20,
      gap: 16,
      backgroundColor: colors.background,
      justifyContent: "center"
    },
    card: {
      backgroundColor: colors.surface,
      padding: 20,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 6
    },
    eyebrow: {
      color: colors.textMuted,
      fontWeight: "700",
      letterSpacing: 0.3
    },
    name: { color: colors.textMain, fontSize: 26, fontWeight: "800" },
    role: { color: colors.textMuted, fontSize: 16, marginBottom: 6 },
    copy: {
      color: colors.textMain,
      lineHeight: 20
    },
    cta: {
      backgroundColor: colors.primary,
      paddingVertical: 18,
      borderRadius: 16,
      alignItems: "center",
      shadowColor: "#000",
      shadowOpacity: 0.15,
      shadowOffset: { width: 0, height: 6 },
      shadowRadius: 10,
      elevation: 4
    },
    ctaText: { color: colors.primaryText, fontSize: 18, fontWeight: "800" },
    hint: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      gap: 4
    },
    hintLabel: { color: colors.textMain, fontWeight: "700" },
    hintCopy: { color: colors.textMuted, lineHeight: 18 }
  });
