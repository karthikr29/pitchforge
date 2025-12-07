import { Pressable, StyleSheet, Text, View, Switch } from "react-native";
import { useTheme } from "../context/ThemeContext";

export function ThemeToggle() {
  const { colors, choice, setChoice } = useTheme();

  const toggle = async () => {
    const next = choice === "light" ? "dark" : "light";
    await setChoice(next);
  };

  return (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <Text style={[styles.labelText, { color: colors.textMain }]}>Dark mode</Text>
      <Switch
        value={choice === "dark"}
        onValueChange={toggle}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={choice === "dark" ? colors.primaryText : colors.surface}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1
  },
  labelText: {
    fontWeight: "700",
    fontSize: 14
  }
});

