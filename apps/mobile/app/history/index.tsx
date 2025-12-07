import { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, FlatList } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { Swipeable } from "react-native-gesture-handler";
import { Message } from "../../src/types";
import { personas } from "../../src/constants/personas";
import { useTheme } from "../../src/context/ThemeContext";

type Transcript = {
  id: string;
  createdAt: string;
  messages: Message[];
  personaId?: string;
  durationSec?: number;
  rating?: number;
};

export default function HistoryList() {
  const router = useRouter();
  const [data, setData] = useState<Transcript[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const loadTranscripts = useCallback(async () => {
    const raw = await AsyncStorage.getItem("transcripts");
    if (!raw) {
      setData([]);
      return;
    }
    setData(JSON.parse(raw));
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadTranscripts();
    }, [loadTranscripts])
  );

  const openTranscript = (id: string) => router.push(`/history/${id}`);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    const next = data.filter((t) => t.id !== id);
    setData(next);
    await AsyncStorage.setItem("transcripts", JSON.stringify(next));
    setDeletingId(null);
  };

  const renderRightActions = (item: Transcript) => () => (
    <View style={styles.actionsContainer}>
      <Pressable style={[styles.actionButton, styles.infoButton]} onPress={() => openTranscript(item.id)}>
        <Text style={styles.actionText}>Info</Text>
      </Pressable>
      <Pressable
        style={[styles.actionButton, styles.deleteButton]}
        onPress={() => handleDelete(item.id)}
        disabled={deletingId === item.id}
      >
        <Text style={styles.actionText}>{deletingId === item.id ? "Deleting..." : "Delete"}</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Past Calls</Text>
      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Swipeable renderRightActions={renderRightActions(item)}>
            <Pressable style={styles.row} onPress={() => openTranscript(item.id)}>
              <Text style={styles.rowText}>
                {personas.find((p) => p.id === item.personaId)?.name ?? "Unknown persona"}
              </Text>
              <Text style={styles.subText}>
                {new Date(item.createdAt).toLocaleString()} · {Math.max(1, Math.round(((item.durationSec ?? item.messages.length * 25) / 60)))} min
              </Text>
            </Pressable>
          </Swipeable>
        )}
        ListEmptyComponent={<Text style={styles.subText}>No history yet.</Text>}
      />
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: { flex: 1, padding: 16, backgroundColor: colors.background },
    title: { color: colors.textMain, fontSize: 22, fontWeight: "800", marginBottom: 12 },
    row: {
      backgroundColor: colors.surface,
      padding: 12,
      borderRadius: 10,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: colors.border
    },
    rowText: { color: colors.textMain, fontWeight: "700" },
    subText: { color: colors.textMuted, marginTop: 4 },
    actionsContainer: {
      flexDirection: "row",
      alignItems: "stretch",
      height: "100%"
    },
    actionButton: {
      justifyContent: "center",
      paddingHorizontal: 16
    },
    infoButton: {
      backgroundColor: colors.surface,
      borderLeftWidth: 1,
      borderColor: colors.border
    },
    deleteButton: {
      backgroundColor: "#E53935"
    },
    actionText: {
      color: colors.primaryText,
      fontWeight: "700"
    }
  });

