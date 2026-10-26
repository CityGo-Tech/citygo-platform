import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AiModeConsentView } from "@citygo/api-client";
import { aiModeLabels } from "@citygo/contracts";
import { tokens } from "@citygo/design-tokens";
import { Button } from "@citygo/ui-native";

type ReadyView = Extract<AiModeConsentView, { phase: "ready" | "saving" }>;

function CurrentConditions({
  view,
  onConfirm,
  onLegal,
}: {
  view: ReadyView;
  onConfirm: (checked: boolean) => void;
  onLegal: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const saving = view.phase === "saving";
  const document = view.consent.policy.personalData;
  return (
    <View style={styles.content}>
      <Pressable
        accessibilityRole="link"
        onPress={onLegal}
        style={styles.textAction}
      >
        <Text style={styles.link}>Условия обработки персональных данных</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.textAction}
      >
        <Text style={styles.link}>
          {expanded ? "Скрыть условия" : "Прочитать условия здесь"}
        </Text>
      </Pressable>
      {expanded && (
        <View style={styles.terms}>
          <Text style={styles.version}>
            Редакция {view.consent.policy.version}
          </Text>
          <Text selectable style={styles.body}>
            {document.text}
          </Text>
        </View>
      )}
      <View style={styles.choice}>
        <Switch
          accessibilityLabel={document.label}
          value={checked}
          disabled={saving}
          onValueChange={setChecked}
        />
        <Text style={styles.choiceLabel}>{document.label}</Text>
      </View>
      <Button
        title={saving ? "Сохраняем…" : "Подтвердить и выбрать"}
        disabled={saving || !checked}
        onPress={() => onConfirm(checked)}
      />
    </View>
  );
}

export function MobileAiModeConsentModal({
  view,
  onConfirm,
  onCancel,
  onRetry,
  onLegal,
}: {
  view: AiModeConsentView;
  onConfirm: (checked: boolean) => void;
  onCancel: () => void;
  onRetry: () => void;
  onLegal: () => void;
}) {
  if (view.phase === "closed") return null;
  const ready = view.phase === "ready" || view.phase === "saving";
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onCancel}>
      <SafeAreaView style={styles.overlay}>
        <View
          accessibilityViewIsModal
          importantForAccessibility="yes"
          style={styles.panel}
        >
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text accessibilityRole="header" style={styles.title}>
              Новый режим ответа
            </Text>
            <Text style={styles.body}>
              Для первого выбора режима «{aiModeLabels[view.mode]}» подтвердите
              обновлённые условия обработки данных.
            </Text>
            {view.phase === "loading" && (
              <Text accessibilityLiveRegion="polite" style={styles.body}>
                Загружаем условия…
              </Text>
            )}
            {view.phase === "error" && (
              <View style={styles.content}>
                <Text accessibilityRole="alert" style={styles.error}>
                  {view.message}
                </Text>
                <Button title="Загрузить условия" onPress={onRetry} />
              </View>
            )}
            {ready && (
              <CurrentConditions
                key={
                  view.mode +
                  ":" +
                  view.consent.policy.version +
                  ":" +
                  view.consent.policy.aiProcessing?.id
                }
                view={view}
                onConfirm={onConfirm}
                onLegal={onLegal}
              />
            )}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            onPress={onCancel}
            style={styles.cancel}
          >
            <Text style={styles.cancelText}>Отмена</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 12,
  },
  panel: {
    width: "100%",
    maxWidth: 560,
    maxHeight: "100%",
    flexShrink: 1,
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.card,
    borderWidth: 1,
    borderColor: tokens.color.border,
    padding: tokens.space.lg,
    gap: tokens.space.md,
  },
  scroll: { flexShrink: 1, minHeight: 0 },
  content: { gap: tokens.space.md },
  title: {
    color: tokens.color.foreground,
    fontSize: 23,
    fontWeight: "700",
  },
  body: { color: tokens.color.foreground, lineHeight: 22 },
  textAction: { minHeight: 44, justifyContent: "center" },
  link: {
    color: tokens.color.primaryStrong,
    textDecorationLine: "underline",
  },
  terms: {
    backgroundColor: tokens.color.background,
    borderRadius: tokens.radius.control,
    padding: tokens.space.md,
    gap: tokens.space.sm,
  },
  version: { color: tokens.color.muted, fontSize: 13 },
  choice: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  choiceLabel: { flex: 1, color: tokens.color.foreground, lineHeight: 22 },
  error: { color: tokens.color.danger },
  cancel: {
    minHeight: 48,
    borderRadius: tokens.radius.control,
    borderWidth: 1,
    borderColor: tokens.color.border,
    justifyContent: "center",
    alignItems: "center",
    padding: 12,
  },
  cancelText: { color: tokens.color.primaryStrong, fontWeight: "700" },
});
