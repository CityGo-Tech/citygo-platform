import { useEffect, useRef, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fetch as expoFetch } from "expo/fetch";
import { useFonts } from "expo-font";
import type { PersonalPlanState, SessionTicket } from "@citygo/api-client";
import { tokens } from "@citygo/design-tokens";
import { createMobilePersonalPlan } from "./personal-plan-client";
import citygoLogo from "../../web/public/figma/citygo-original-logo.png";
import manropeFont from "../../web/src/app/fonts/Manrope.ttf";

export type MobilePlanAccess = {
  userId: string;
  token: string;
  sessionTicket: SessionTicket;
};

/** The private plan has its own lifetime; it never submits an AI message. */
export function MobilePersonalPlan({
  base,
  access,
  xp,
  onClose,
  onAccessDenied,
  onOpenWebPlan,
}: {
  base: string;
  access: MobilePlanAccess;
  xp: number;
  onClose: () => void;
  onAccessDenied: () => void;
  onOpenWebPlan: () => void;
}) {
  const [fontsLoaded] = useFonts({
    Manrope: manropeFont,
  });
  const [snapshot, setSnapshot] = useState<{
    access: MobilePlanAccess;
    state: PersonalPlanState;
  } | null>(null);
  const resource = useRef<ReturnType<typeof createMobilePersonalPlan> | null>(
    null,
  );
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  useEffect(() => {
    const current = createMobilePersonalPlan({
      base,
      ...access,
      fetch: expoFetch,
      publish: (state) => setSnapshot({ access, state }),
      onAccessDenied: () => denied.current(),
    });
    resource.current = current;
    void current.load();
    return () => {
      current.dispose();
      if (resource.current === current) resource.current = null;
    };
  }, [base, access]);

  const current =
    access.sessionTicket.active() && snapshot?.access === access
      ? snapshot.state
      : null;
  const actions = current ? resource.current : null;
  const summary = current?.summary;
  const busy = !current || current.phase === "loading" || current.mutating;
  const blocked = busy || current?.needsRefresh || !actions;
  const font = fontsLoaded ? styles.font : undefined;
  const copy = [styles.copy, font];
  const filters = [
    ["all", "Все", summary?.total],
    ["pending", "В работе", summary?.pending],
    ["completed", "Выполнено", summary?.completed],
  ] as const;
  const progress = summary?.total
    ? Math.round((summary.completed / summary.total) * 100)
    : 0;

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View accessible accessibilityLabel="Ситиго" style={styles.brand}>
            <View style={styles.brandSymbol}>
              <Image
                accessible={false}
                source={citygoLogo}
                style={styles.symbolImage}
              />
            </View>
            <View style={styles.brandWord}>
              <Image
                accessible={false}
                source={citygoLogo}
                style={styles.wordImage}
              />
            </View>
          </View>
          <Text style={[styles.xp, font]}>{xp} XP</Text>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <PlanButton title="Назад" onPress={onClose} secondary />
          <Text style={[styles.meta, font]}>CITYGO · ВАШ ПЕРЕЕЗД</Text>
          <Text accessibilityRole="header" style={[styles.title, font]}>
            Ваш переезд — понятными шагами
          </Text>
          <Text style={[styles.subtitle, font]}>
            Мой план: сохранённые шаги и ваш прогресс.
          </Text>
          {current?.phase !== "closed" && (
            <>
              {summary && (
                <View style={styles.card}>
                  <Text style={[styles.meta, font]}>МОЙ ПЛАН</Text>
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.cardTitle, font]}
                  >
                    Выполнено {summary.completed} из {summary.total}
                  </Text>
                  <View
                    accessible
                    accessibilityRole="progressbar"
                    accessibilityLabel="Прогресс моего плана"
                    accessibilityValue={{ min: 0, max: 100, now: progress }}
                    style={styles.track}
                  >
                    <View style={[styles.fill, { width: `${progress}%` }]} />
                  </View>
                </View>
              )}
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel="Статус шагов плана"
                style={styles.filters}
              >
                {filters.map(([value, label, count]) => (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityLabel={`${label}: ${count ?? "загрузка"}`}
                    accessibilityState={{
                      checked: (current?.filter ?? "all") === value,
                      disabled: !actions || current?.mutating,
                    }}
                    disabled={!actions || current?.mutating}
                    onPress={() => void actions?.select(value)}
                    style={[
                      styles.filter,
                      (current?.filter ?? "all") === value && styles.selected,
                    ]}
                  >
                    <Text style={[copy, styles.filterLabel]}>{label}</Text>
                    <Text style={[copy, styles.count]}>{count ?? "—"}</Text>
                  </Pressable>
                ))}
              </View>
              {!!current?.error && (
                <Text accessibilityRole="alert" style={[copy, styles.error]}>
                  {current.error}
                </Text>
              )}
              <PlanButton
                title="Обновить план"
                disabled={busy}
                onPress={() => void actions?.load()}
                secondary
              />
              {busy && (
                <Text accessibilityLiveRegion="polite" style={copy}>
                  {current?.mutating ? "Сохраняем шаг…" : "Загружаем план…"}
                </Text>
              )}
              {!busy && !current?.error && !current?.items.length && (
                <View style={styles.card}>
                  <Text style={[styles.cardTitle, font]}>
                    {summary?.total === 0
                      ? "Начнём с того, что важно вам"
                      : current?.filter === "completed"
                        ? "Выполненных шагов пока нет"
                        : "Нет шагов в работе"}
                  </Text>
                  <Text style={copy}>
                    {summary?.total === 0
                      ? "Добавьте шаг из диалога в веб-версии CityGo. Он появится здесь, и вы сможете отметить его выполнение."
                      : current?.filter === "completed"
                        ? "Отметьте готовый шаг — он появится здесь."
                        : "Вы завершили все сохранённые шаги."}
                  </Text>
                </View>
              )}
              {current?.items.map((item) => (
                <View key={item.id} style={styles.card}>
                  <Text style={[styles.meta, font]}>
                    {item.status === "completed" ? "ВЫПОЛНЕНО" : "В РАБОТЕ"}
                  </Text>
                  <Text style={[styles.cardTitle, font]}>{item.title}</Text>
                  {!!item.details && (
                    <Text selectable style={copy}>
                      {item.details}
                    </Text>
                  )}
                  <PlanButton
                    title={
                      item.status === "completed"
                        ? "Вернуть в работу"
                        : "Отметить выполненным"
                    }
                    disabled={blocked}
                    onPress={() =>
                      void actions?.update(item, {
                        expectedRevision: item.revision,
                        title: item.title,
                        details: item.details,
                        status:
                          item.status === "completed" ? "pending" : "completed",
                      })
                    }
                    secondary={item.status === "completed"}
                  />
                </View>
              ))}
              {!!current?.nextBefore && (
                <PlanButton
                  title="Показать ещё шаги"
                  disabled={blocked}
                  onPress={() => void actions?.loadMore()}
                  secondary
                />
              )}
              <PlanButton title="Продолжить разговор" onPress={onClose} />
              <PlanButton
                title="Добавить или изменить шаг в веб-версии"
                onPress={onOpenWebPlan}
                secondary
              />
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function PlanButton({
  title,
  onPress,
  disabled = false,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary && styles.secondary,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonLabel, secondary && styles.secondaryLabel]}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.color.background },
  font: { fontFamily: "Manrope" },
  content: { padding: 16, gap: 16, paddingBottom: 32 },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 72,
    backgroundColor: tokens.color.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  brand: {
    width: 192,
    height: 40,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  brandSymbol: { width: 52, height: 36.63, overflow: "hidden" },
  brandWord: { width: 128.65, height: 40, overflow: "hidden" },
  symbolImage: {
    position: "absolute",
    width: "210.38%",
    height: "298.66%",
    left: "-55.35%",
    top: "-79.02%",
  },
  wordImage: {
    position: "absolute",
    width: "281.09%",
    height: "904.05%",
    left: "-90.44%",
    top: "-574.7%",
  },
  xp: {
    color: tokens.color.foreground,
    padding: 14,
    borderWidth: 1,
    borderColor: tokens.color.border,
    borderRadius: tokens.radius.control,
  },
  meta: { color: tokens.color.primaryStrong, fontSize: 11, fontWeight: "700" },
  title: { color: tokens.color.foreground, fontSize: 28, fontWeight: "700" },
  subtitle: { color: tokens.color.muted, fontSize: 14, lineHeight: 21 },
  copy: { color: tokens.color.muted, fontSize: 16, lineHeight: 24 },
  card: {
    backgroundColor: tokens.color.surface,
    borderColor: tokens.color.border,
    borderWidth: 1,
    borderRadius: tokens.radius.card,
    padding: 24,
    gap: 8,
  },
  cardTitle: {
    color: tokens.color.foreground,
    fontSize: 20,
    fontWeight: "700",
  },
  track: {
    height: 8,
    borderRadius: 999,
    backgroundColor: tokens.color.progressTrack,
    overflow: "hidden",
    marginTop: 8,
  },
  fill: { height: "100%", backgroundColor: tokens.color.primaryStrong },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  filter: {
    flexGrow: 1,
    minHeight: 48,
    padding: 12,
    borderWidth: 1,
    borderColor: tokens.color.border,
    borderRadius: tokens.radius.control,
    backgroundColor: tokens.color.surface,
    alignItems: "center",
  },
  selected: {
    backgroundColor: tokens.color.primarySoft,
    borderColor: tokens.color.primaryStrong,
  },
  filterLabel: { color: tokens.color.foreground, fontSize: 14 },
  count: { color: tokens.color.primaryStrong, fontSize: 13 },
  button: {
    minHeight: 48,
    borderRadius: tokens.radius.control,
    backgroundColor: tokens.color.primaryStrong,
    borderWidth: 1,
    borderColor: tokens.color.primaryStrong,
    padding: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonLabel: {
    color: tokens.color.onAction,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  secondary: {
    backgroundColor: tokens.color.surface,
    borderColor: tokens.color.border,
  },
  secondaryLabel: { color: tokens.color.foreground },
  disabled: { opacity: 0.5 },
  error: { color: tokens.color.danger },
});
