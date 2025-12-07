import { useMemo } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSessionStore } from "../src/state/useSessionStore";
import { useTheme } from "../src/context/ThemeContext";

export default function FeedbackScreen() {
  const router = useRouter();
  const { feedback, messages } = useSessionStore();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Feedback</Text>
      {feedback ? (
        <View style={styles.card}>
          <Text style={styles.score}>Score: {feedback.score}/10</Text>
          <Text style={styles.section}>Strengths</Text>
          {feedback.strengths.map((s, idx) => (
            <Text key={idx} style={styles.item}>
              • {s}
            </Text>
          ))}
          <Text style={styles.section}>Weaknesses</Text>
          {feedback.weaknesses.map((s, idx) => (
            <Text key={idx} style={styles.item}>
              • {s}
            </Text>
          ))}
          <Text style={styles.section}>Better Phrasing</Text>
          {feedback.suggestions.map((s, idx) => (
            <Text key={idx} style={styles.item}>
              • {s}
            </Text>
          ))}
        </View>
      ) : (
        <Text style={styles.muted}>Feedback not generated yet.</Text>
      )}

      <View style={styles.card}>
        <Text style={styles.section}>Transcript</Text>
        {messages.map((m) => (
          <Text key={m.id} style={styles.item}>
            {m.role.toUpperCase()}: {m.text}
          </Text>
        ))}
      </View>

      <Pressable style={styles.button} onPress={() => router.replace("/")}>
        <Text style={styles.buttonText}>Back Home</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: { flex: 1, padding: 16, gap: 12, backgroundColor: colors.background },
    title: { color: colors.textMain, fontSize: 22, fontWeight: "800" },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border
    },
    score: { color: colors.primary, fontSize: 18, fontWeight: "700", marginBottom: 8 },
    section: { color: colors.textMain, fontWeight: "700", marginTop: 8 },
    item: { color: colors.textMuted, marginTop: 4 },
    muted: { color: colors.textMuted },
    button: {
      backgroundColor: colors.primary,
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: "center"
    },
    buttonText: { color: colors.primaryText, fontWeight: "800" }
  });

