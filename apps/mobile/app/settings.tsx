import { useMemo } from "react";
import { View, Text, StyleSheet, Pressable, Alert } from "react-native";
import { useTheme } from "../src/context/ThemeContext";
import { ThemeToggle } from "../src/components/ThemeToggle";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function SettingsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const clearData = async () => {
    await AsyncStorage.removeItem("transcripts");
    Alert.alert("Data cleared", "Call transcripts have been removed.");
  };

  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => router.back()} />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            paddingBottom: insets.bottom + 12
          }
        ]}
      >
        <View style={styles.sheetHeader}>
          <View style={styles.headerSpacer} />
          <Text style={styles.sheetTitle}>Settings</Text>
          <Pressable
            accessibilityLabel="Close settings"
            hitSlop={10}
            onPress={() => router.back()}
            style={styles.headerClose}
          >
            <Ionicons name="close" size={20} color={colors.textMain} />
          </Pressable>
        </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Appearance</Text>
        <ThemeToggle />
      </View>

      <View style={styles.card}>
          <Text style={styles.cardTitle}>Account Data</Text>
        <SettingsRow label="Account" onPress={() => Alert.alert("Account", "Account page TBD")} />
        <SettingsRow label="Delete data" onPress={clearData} />
        </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Support</Text>
          <SettingsRow label="Support / Contact" onPress={() => router.push("/feedback")} />
        <SettingsRow
          label="Rate this app"
          onPress={() => Alert.alert("Rate", "Store link coming soon.")}
        />
        <SettingsRow
          label="Manage notifications"
          onPress={() => Alert.alert("Notifications", "Notification settings not wired yet.")}
        />
          <SettingsRow label="Feedback" onPress={() => router.push("/feedback")} />
        </View>
      </View>
    </View>
  );
}

function SettingsRow({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderColor: colors.border,
          opacity: pressed ? 0.7 : 1
        }
      ]}
    >
      <Text style={{ color: colors.textMain, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: "rgba(0,0,0,0.25)"
    },
    sheet: {
      paddingHorizontal: 16,
      paddingTop: 14,
      gap: 12,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderWidth: 1,
      shadowColor: "#000",
      shadowOpacity: colors.background === "#FFFFFF" ? 0.08 : 0,
      shadowOffset: { width: 0, height: 6 },
      shadowRadius: 14,
      elevation: colors.background === "#FFFFFF" ? 6 : 0
    },
    sheetHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingBottom: 4
    },
    sheetTitle: {
      flex: 1,
      fontSize: 20,
      fontWeight: "800",
      color: colors.textMain,
      textAlign: "center"
    },
    headerSpacer: {
      width: 32
    },
    headerClose: {
      width: 32,
      alignItems: "flex-end"
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      gap: 8
    },
    cardTitle: {
      color: colors.textMain,
      fontWeight: "800",
      fontSize: 16,
      marginBottom: 6
    }
  });

