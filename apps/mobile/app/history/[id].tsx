import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams } from "expo-router";
import { Message } from "../../src/types";
import { personas } from "../../src/constants/personas";
import { useTheme } from "../../src/context/ThemeContext";
import { fetchTranscriptRemote } from "../../src/api/transcripts";

type Transcript = {
  id: string;
  createdAt: string;
  messages: Message[];
  personaId?: string;
  durationSec?: number;
  rating?: number;
};

export default function TranscriptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  useEffect(() => {
    (async () => {
      try {
        const remote = await fetchTranscriptRemote(id);
        if (remote) {
          setTranscript({
            id: remote.id,
            createdAt: remote.created_at,
            messages: remote.messages ?? [],
            personaId: remote.persona_id,
            durationSec: remote.duration_sec
          });
          return;
        }
      } catch {
        // fallback
      }
      const raw = await AsyncStorage.getItem("transcripts");
      if (!raw) return;
      const parsed: Transcript[] = JSON.parse(raw);
      setTranscript(parsed.find((t) => t.id === id) ?? null);
    })();
  }, [id]);

  if (!transcript) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Transcript not found</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Call on {new Date(transcript.createdAt).toLocaleString()}</Text>
      <Text style={styles.meta}>
        {personas.find((p) => p.id === transcript.personaId)?.name ?? "Unknown persona"} ·{" "}
        {Math.max(1, Math.round(((transcript.durationSec ?? transcript.messages.length * 25) / 60)))} min
      </Text>
      <ScrollView style={{ marginTop: 12 }}>
        {transcript.messages.map((m) => (
          <Text key={m.id} style={styles.line}>
            {m.role.toUpperCase()}: {m.text}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: { flex: 1, padding: 16, backgroundColor: colors.background },
    title: { color: colors.textMain, fontSize: 20, fontWeight: "800" },
    meta: { color: colors.textMuted, marginTop: 6 },
    line: { color: colors.textMuted, marginBottom: 6 }
  });

