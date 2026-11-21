import { useEffect, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { SafeAreaView } from "react-native-safe-area-context";
import { tokens } from "@citygo/design-tokens";
import { Button, Card } from "@citygo/ui-native";
import { readSavedPlanResult, type SavedPlanAccess } from "./saved-plan-link";

type Read = Awaited<ReturnType<typeof readSavedPlanResult>>;
export function MobileSavedPlanResult({
  base,
  id,
  access,
  onBackToPlan,
  onSessionExpired,
}: {
  base: string;
  id: string;
  access: SavedPlanAccess;
  onBackToPlan: () => void;
  onSessionExpired: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{
    access: SavedPlanAccess;
    read: Read;
  } | null>(null);
  const read = snapshot?.access === access ? snapshot.read : null;
  const [attempt, setAttempt] = useState(0);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;

  useEffect(() => {
    const controller = new AbortController();
    void readSavedPlanResult({
      base,
      fetch: expoFetch,
      id,
      access,
      signal: controller.signal,
    }).then((outcome) => {
      if (
        !outcome ||
        controller.signal.aborted ||
        !access.sessionTicket.active()
      )
        return;
      if (outcome.phase === "expired") {
        expired.current();
        return;
      }
      setSnapshot({ access, read: outcome });
    });
    return () => controller.abort();
  }, [base, id, access, attempt]);

  const result = read?.phase === "opened" ? read.result : null;
  // The plan API's canonical discussion text starts with its title.
  const body = result
    ? result.text === result.title
      ? ""
      : result.text.startsWith(result.title + "\n\n")
        ? result.text.slice(result.title.length + 2)
        : result.text
    : "";

  return (
    <Modal visible onRequestClose={onBackToPlan}>
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <Card>
            <Text accessibilityRole="header" style={styles.title}>
              {result?.title ?? "Сохранённый результат"}
            </Text>
            {result ? (
              !!body && (
                <Text selectable style={styles.text}>
                  {body}
                </Text>
              )
            ) : (
              <Text accessibilityLiveRegion="polite" style={styles.text}>
                {read?.phase === "unavailable"
                  ? "Результат недоступен в этом аккаунте."
                  : read?.phase === "retry"
                    ? "Не удалось открыть результат. Попробуйте ещё раз."
                    : "Открываем сохранённый результат…"}
              </Text>
            )}
            {read?.phase === "retry" && (
              <Button
                title="Повторить"
                onPress={() => {
                  setSnapshot(null);
                  setAttempt((value) => value + 1);
                }}
              />
            )}
            <Button title="Вернуться к плану" onPress={onBackToPlan} />
          </Card>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.color.background },
  content: { padding: tokens.space.lg },
  title: {
    color: tokens.color.foreground,
    fontSize: 26,
    fontWeight: "700",
  },
  text: { color: tokens.color.foreground, fontSize: 16, lineHeight: 24 },
});
