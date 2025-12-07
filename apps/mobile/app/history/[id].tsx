import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { Stack } from "expo-router";
import { Message } from "../../src/types";
import { personas } from "../../src/constants/personas";
import { useTheme } from "../../src/context/ThemeContext";
import { deleteTranscriptRemote, fetchTranscriptRemote } from "../../src/api/transcripts";

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
  const [deleting, setDeleting] = useState(false);
  const navigation = useNavigation();
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

  const removeLocal = async () => {
    const raw = await AsyncStorage.getItem("transcripts");
    if (!raw) return;
    const parsed: Transcript[] = JSON.parse(raw);
    const next = parsed.filter((t) => t.id !== id);
    await AsyncStorage.setItem("transcripts", JSON.stringify(next));
  };

  const handleDelete = async () => {
    if (!id || deleting) return;
    Alert.alert("Delete transcript?", "This will remove it permanently.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            setDeleting(true);
            await deleteTranscriptRemote(id);
            await removeLocal();
            Alert.alert("Deleted", "Transcript removed");
            // Navigate back to history list
            navigation.goBack();
          } catch (err: any) {
            Alert.alert("Delete failed", err?.message ?? String(err));
          } finally {
            setDeleting(false);
          }
        }
      }
    ]);
  };

  const handleCopy = async () => {
    if (!transcript) return;
    const text = transcript.messages
      .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
      .join("\n");
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied", "Transcript copied to clipboard");
  };

  if (!transcript) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Transcript not found</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{}} />
      <View style={styles.container}>
        <Text style={styles.title}>Call on {new Date(transcript.createdAt).toLocaleString()}</Text>
        <Text style={styles.meta}>
          {personas.find((p) => p.id === transcript.personaId)?.name ?? "Unknown persona"} ·{" "}
          {Math.max(1, Math.round(((transcript.durationSec ?? transcript.messages.length * 25) / 60)))} min
        </Text>
        <ScrollView style={{ marginTop: 12 }}>
          {transcript.messages.map((m, idx) => (
            <Text key={m.id ?? `${m.role}-${idx}`} style={styles.line}>
              {m.role.toUpperCase()}: {m.text}
            </Text>
          ))}
        </ScrollView>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy transcript"
            onPress={handleCopy}
            style={[styles.actionButton, styles.copyButton]}
          >
            <Text style={styles.copyText}>Copy transcript</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete transcript"
            onPress={handleDelete}
            disabled={deleting}
            style={[styles.actionButton, styles.deleteButton, deleting && styles.deleteButtonDisabled]}
          >
            <Text style={styles.deleteText}>Delete</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: {
      flex: 1,
      padding: 16,
      paddingBottom: 32,
      backgroundColor: colors.background
    },
    title: { color: colors.textMain, fontSize: 20, fontWeight: "800" },
    meta: { color: colors.textMuted, marginTop: 6 },
    line: { color: colors.textMuted, marginBottom: 6 },
    actions: {
      marginTop: 16,
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 12
    },
    actionButton: {
      flex: 1,
      paddingHorizontal: 18,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 1,
      alignItems: "center"
    },
    copyButton: {
      backgroundColor: colors.surface,
      borderColor: colors.border
    },
    copyText: { color: colors.textMain, fontWeight: "700" },
    deleteButton: {
      backgroundColor: "#b00020",
      borderColor: "#b00020"
    },
    deleteButtonDisabled: { opacity: 0.6 },
    deleteText: { color: "#fff", fontWeight: "700" }
  });

