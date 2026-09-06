import {
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
  type TextInputProps,
} from "react-native";
import type { ReactNode } from "react";
import { tokens } from "@citygo/design-tokens";
export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}
export function Button({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 7 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={tokens.color.muted}
        {...props}
        style={[styles.input, props.style]}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.card,
    padding: tokens.space.lg,
    borderWidth: 1,
    borderColor: tokens.color.border,
    gap: 16,
  },
  button: {
    backgroundColor: tokens.color.primaryStrong,
    borderRadius: tokens.radius.control,
    padding: 15,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "700" },
  label: { color: tokens.color.foreground, fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: tokens.color.border,
    borderRadius: tokens.radius.control,
    padding: 13,
    color: tokens.color.foreground,
    fontSize: 16,
  },
});
