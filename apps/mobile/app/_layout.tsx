import { useEffect, useMemo, useRef, useState } from "react";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  Linking,
  Alert,
  Platform
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "../src/context/ThemeContext";
import { useSessionStore } from "../src/state/useSessionStore";

function LayoutStack() {
  const router = useRouter();
  const { colors } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.textMain,
        contentStyle: { backgroundColor: colors.background },
        headerRight: () => <HeaderMenu />,
        headerBackTitleVisible: false,
        headerBackTitle: ""
      }}
    >
      <Stack.Screen name="index" options={{ title: "Dashboard" }} />
      <Stack.Screen name="personas" options={{ title: "Personas" }} />
      <Stack.Screen name="conversation" options={{ title: "Conversation", presentation: "card" }} />
      <Stack.Screen name="feedback" options={{ title: "Feedback" }} />
      <Stack.Screen name="history/index" options={{ title: "History" }} />
      <Stack.Screen name="history/[id]" options={{ title: "Transcript" }} />
      <Stack.Screen
        name="settings"
        options={{
          presentation: "transparentModal",
          headerShown: false,
          contentStyle: { backgroundColor: "transparent" },
          animation: "slide_from_bottom"
        }}
      />
    </Stack>
  );
}

function HeaderMenu() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const width = Dimensions.get("window").width * 0.75;
  const translate = useRef(new Animated.Value(width)).current;
  const { remainingMinutes } = useSessionStore();
  const insets = useSafeAreaInsets();

  const items: Array<{ label: string; action: () => void }> = [
    { label: "Settings", action: () => router.push("/settings") },
    { label: "Privacy Policy", action: () => Linking.openURL("https://example.com/privacy") },
    { label: "Terms of Use", action: () => Linking.openURL("https://example.com/terms") },
    { label: "About", action: () => Alert.alert("About", "About coming soon.") },
    { label: "Licenses", action: () => Alert.alert("Licenses", "Licenses coming soon.") }
  ];

  useEffect(() => {
    if (open) {
      Animated.timing(translate, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    } else {
      Animated.timing(translate, { toValue: width, duration: 200, useNativeDriver: true }).start();
    }
  }, [open, translate, width]);

  return (
    <>
      <Pressable
        accessibilityLabel="Open menu"
        onPress={() => setOpen(true)}
        style={{ paddingHorizontal: 12, paddingVertical: 6 }}
      >
        <Ionicons name="menu" size={22} color={colors.icon} />
      </Pressable>
      <Modal
        visible={open}
        animationType="fade"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          <Animated.View
            style={[
              styles.sheet,
              { width, paddingTop: insets.top + 12, transform: [{ translateX: translate }] }
            ]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Menu</Text>
              <Text style={styles.minutes}>
                Minutes Remaining: {remainingMinutes ?? "—"}
              </Text>
            </View>
            {items.map((item) => (
              <Pressable
                key={item.label}
                style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                onPress={() => {
                  setOpen(false);
                  item.action();
                }}
              >
                <Text style={styles.itemText}>{item.label}</Text>
              </Pressable>
            ))}
          </Animated.View>
        </Pressable>
      </Modal>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <LayoutStack />
    </ThemeProvider>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.25)",
      justifyContent: "flex-end",
      alignItems: "flex-end"
    },
    sheet: {
      backgroundColor: colors.surface,
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderLeftWidth: 1,
      borderColor: colors.border,
      height: "100%"
    },
    sheetHeader: { marginBottom: 12 },
    sheetTitle: { color: colors.textMain, fontWeight: "800", fontSize: 18 },
    minutes: { color: colors.textMuted, marginTop: 4 },
    item: {
      paddingVertical: 12
    },
    itemPressed: { opacity: 0.6 },
    itemText: {
      color: colors.textMain,
      fontWeight: "700",
      fontSize: 15
    }
  });

