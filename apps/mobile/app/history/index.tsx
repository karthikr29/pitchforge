import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, FlatList } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem("transcripts");
      if (raw) setData(JSON.parse(raw));
    })();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Past Calls</Text>
      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push(`/history/${item.id}`)}
          >
            <Text style={styles.rowText}>
              {personas.find((p) => p.id === item.personaId)?.name ?? "Unknown persona"}
            </Text>
            <Text style={styles.subText}>
              {new Date(item.createdAt).toLocaleString()} · {Math.max(1, Math.round(((item.durationSec ?? item.messages.length * 25) / 60)))} min
            </Text>
          </Pressable>
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
    subText: { color: colors.textMuted, marginTop: 4 }
  });

