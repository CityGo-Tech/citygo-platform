"use client";

import Image from "next/image";
import Script from "next/script";
import dynamic from "next/dynamic";
import { Button, Card, Field } from "@citygo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { housingFirstPaymentDetails } from "../housing-first-payment";
import {
  landingTaskFromValue,
  type LandingTask,
} from "../landing/landing-task";
import {
  cityGoEntryPath,
  miniAppLaunch,
  type MiniAppBridge,
  type MiniAppHost,
  type MiniAppLaunch,
} from "./host";
import styles from "./mini-app-entry.module.css";
import type { MiniAppAccountAccess } from "./account-access";
import { trackMiniAppKeyboard } from "./viewport";

type Screen = "welcome" | "housing" | "plan" | "relocation";
type Launch = "checking" | MiniAppLaunch;

const screenForTask = {
  housing: "housing",
  coordinator: "relocation",
} as const;
const budgetFormat = new Intl.NumberFormat("ru-RU");
const CityGoHome = dynamic(() => import("../../app/citygo-home"));

function clearLaunchFragment() {
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
}

export function MiniAppEntry({ host }: { host: MiniAppHost }) {
  const [launch, setLaunch] = useState<Launch>("checking");
  const [bridge, setBridge] = useState<MiniAppBridge>();
  const [accountAccess, setAccountAccess] = useState<MiniAppAccountAccess>();
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [screens, setScreens] = useState<Screen[]>(["welcome"]);
  const screen = screens.at(-1) ?? "welcome";
  const [budget, setBudget] = useState("");
  const [commute, setCommute] = useState("");
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const accountShell = useRef<HTMLDivElement>(null);
  const accountBackHandler = useRef<(() => boolean) | null>(null);
  const entered = useRef(false);
  const connected = useRef(false);
  const accountOpen = Boolean(accountAccess);
  const resumeKey = `citygo:mini-housing-resume:v1:${host.provider}`;
  const rememberHousingOwner = useCallback(
    (ownerId: string | null) => {
      try {
        if (ownerId === null) window.sessionStorage.removeItem(resumeKey);
        else window.sessionStorage.setItem(resumeKey, ownerId);
      } catch {
        // A restricted WebView can still resume when opened from the bot again.
      }
    },
    [resumeKey],
  );

  useEffect(() => {
    const kind = miniAppLaunch(window.location.hash, host.launchFragmentKey);
    setLaunch(kind);
    if (kind === "invalid") clearLaunchFragment();
    if (kind === "browser") {
      try {
        const ownerId = window.sessionStorage.getItem(resumeKey);
        if (ownerId && /^[1-9][0-9]{0,18}$/.test(ownerId)) {
          setAccountAccess({
            provider: host.provider,
            initData: "",
            resumeHousingOwner: ownerId,
          });
        }
      } catch {
        // Browsers can disable session storage.
      }
    }
  }, [host, resumeKey]);

  const changeScreen = useCallback((next: Screen) => {
    entered.current = true;
    setNotice("");
    setScreens((current) => [...current, next]);
  }, []);
  const back = useCallback(() => {
    entered.current = true;
    setNotice("");
    setScreens((current) =>
      current.length > 1 ? current.slice(0, -1) : current,
    );
  }, []);

  useEffect(() => {
    if (entered.current && !accountOpen) heading.current?.focus();
  }, [accountOpen, screen]);

  const returnFromAccount = useCallback(() => {
    entered.current = true;
    setNotice("");
    rememberHousingOwner(null);
    setAccountAccess(undefined);
  }, [rememberHousingOwner]);
  const registerMiniAppBack = useCallback((handler: (() => boolean) | null) => {
    accountBackHandler.current = handler;
  }, []);
  const goBackFromAccount = useCallback(() => {
    if (!accountBackHandler.current?.()) returnFromAccount();
  }, [returnFromAccount]);
  const goBack = accountOpen ? goBackFromAccount : back;
  const canGoBack = accountOpen || screen !== "welcome";

  useEffect(() => {
    if (canGoBack) return bridge?.onBack?.(goBack);
  }, [bridge, canGoBack, goBack]);
  useEffect(() => {
    if (accountOpen && accountShell.current) {
      return trackMiniAppKeyboard(accountShell.current);
    }
  }, [accountOpen]);

  const launchError =
    "Не удалось подключиться к мессенджеру. Откройте CityGo из бота ещё раз.";
  const launchNotice =
    notice || (launch === "invalid" || connectionFailed ? launchError : "");

  const connect = () => {
    if (connected.current) return;
    try {
      const connection = host.connect();
      if (!connection) {
        clearLaunchFragment();
        setConnectionFailed(true);
        return;
      }
      connection.ready?.();
      const task = landingTaskFromValue(connection.initialTask ?? null);
      if (!entered.current && task) changeScreen(screenForTask[task]);
      connected.current = true;
      setBridge(connection);
      setConnectionFailed(false);
      setNotice("");
      clearLaunchFragment();
    } catch {
      clearLaunchFragment();
      setConnectionFailed(true);
    }
  };

  const openCityGo = (task?: LandingTask) => {
    const path = cityGoEntryPath(task);
    if (launch === "browser") {
      window.location.assign(path);
      return;
    }
    if (!bridge) {
      setNotice(launchError);
      return;
    }
    if (bridge.initData) {
      setNotice("");
      setAccountAccess({
        provider: host.provider,
        initData: bridge.initData,
        task,
        ...(task === "housing" && (commute.trim() || budget)
          ? {
              housingCriteria: {
                commute: commute.trim(),
                budgetRub: budget ? Number(budget) : null,
              },
            }
          : {}),
      });
      setCommute("");
      setBudget("");
      return;
    }
    // Older clients can still open the ordinary sign-in without messenger data.
    try {
      bridge.openExternal(new URL(path, window.location.origin).href);
    } catch {
      setNotice("Не удалось открыть CityGo. Попробуйте ещё раз.");
    }
  };

  const closeMiniApp = () => {
    try {
      bridge?.close?.();
    } catch {
      setNotice("Не удалось закрыть CityGo. Закройте окно в мессенджере.");
    }
  };

  return (
    <div
      ref={accountShell}
      className={
        accountOpen ? `${styles.shell} ${styles.accountShell}` : styles.shell
      }
      data-host={host.name}
    >
      {launch === "messenger" && (
        <Script
          src={host.script}
          onReady={connect}
          onError={() => {
            clearLaunchFragment();
            setConnectionFailed(true);
          }}
        />
      )}
      <header className={styles.bar} aria-label={`CityGo в ${host.name}`}>
        <div className={styles.barSide}>
          {canGoBack && (
            <Button
              type="button"
              variant="secondary"
              className={styles.iconButton}
              aria-label="Назад"
              onClick={goBack}
            >
              <Image src="/mini-app/back.svg" width={20} height={20} alt="" />
            </Button>
          )}
        </div>
        <div className={styles.barTitle}>
          <strong>CityGo</strong>
          <span>{host.name}</span>
        </div>
        <div className={styles.barSide}>
          {bridge?.close && (
            <Button
              type="button"
              variant="secondary"
              className={styles.iconButton}
              aria-label={`Закрыть в ${host.name}`}
              onClick={closeMiniApp}
            >
              <Image src="/mini-app/close.svg" width={20} height={20} alt="" />
            </Button>
          )}
        </div>
      </header>
      {accountAccess ? (
        <>
          {launchNotice && (
            <p className={styles.accountNotice} role="status">
              {launchNotice}
            </p>
          )}
          <div className={styles.accountContent}>
            <CityGoHome
              miniApp={accountAccess}
              registerMiniAppBack={registerMiniAppBack}
              rememberHousingOwner={rememberHousingOwner}
            />
          </div>
        </>
      ) : (
        <main className={styles.content}>
          {screen === "welcome" && (
            <>
              <Image
                src="/landing/brand-logo.png"
                alt="Ситиго"
                width={163}
                height={34}
                priority
              />
              <Card className={styles.hero}>
                <div className={styles.intro}>
                  <span className={styles.eyebrow}>Ваш переезд</span>
                  <h1 ref={heading} tabIndex={-1}>
                    С чего начнём?
                  </h1>
                  <p>Можно выбрать одну задачу и уточнить детали позже.</p>
                </div>
                <Image
                  src="/figma/support-assistant.png"
                  className={styles.portrait}
                  alt=""
                  width={64}
                  height={64}
                />
              </Card>
              <TaskButton
                title="Найти жильё"
                detail="Районы, дорога до работы и первый платёж"
                onClick={() => changeScreen("housing")}
              />
              <TaskButton
                title="Оценить переезд"
                detail="Разберите расходы и следующие шаги"
                onClick={() => changeScreen("relocation")}
              />
              <Button
                type="button"
                variant="ghost"
                className={styles.quiet}
                disabled={launch === "checking"}
                onClick={() => openCityGo()}
              >
                Войти в CityGo
              </Button>
            </>
          )}
          {screen === "housing" && (
            <>
              <div className={styles.heading}>
                <h1 ref={heading} tabIndex={-1}>
                  Поиск жилья
                </h1>
                <p>Укажите то, что уже знаете. Любое поле можно пропустить.</p>
              </div>
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  changeScreen("plan");
                }}
              >
                <div className={styles.city}>
                  <span>Город</span>
                  <strong>Москва</strong>
                </div>
                <Field
                  label="Бюджет в месяц, ₽"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99_999_999}
                  step={1}
                  placeholder="Пока не знаю"
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                />
                <Field
                  label="Куда ездить"
                  maxLength={100}
                  placeholder="Пока не указано"
                  value={commute}
                  onChange={(event) => setCommute(event.target.value)}
                />
                <Button type="submit">Собрать стартовый план</Button>
                <Button
                  type="button"
                  variant="ghost"
                  className={styles.quiet}
                  onClick={() => {
                    setBudget("70000");
                    setCommute("Кутузовский проспект");
                  }}
                >
                  Подставить пример
                </Button>
              </form>
            </>
          )}
          {screen === "plan" && (
            <>
              <div className={styles.heading}>
                <h1 ref={heading} tabIndex={-1}>
                  Стартовый план
                </h1>
                <p>
                  {budget
                    ? `Москва · до ${budgetFormat.format(Number(budget))} ₽ в месяц`
                    : "Бюджет можно уточнить позже."}
                </p>
              </div>
              <PlanCard
                title="1. Определите первый платёж"
                detail={housingFirstPaymentDetails}
              />
              <PlanCard
                title="2. Сравните маршруты"
                detail={
                  commute.trim()
                    ? `Проверьте дорогу до ориентира «${commute.trim()}» в обычное для поездок время.`
                    : "Начните с работы и мест, куда ездите чаще всего."
                }
              />
              <PlanCard
                title="3. Подготовьте вопросы"
                detail="Уточните, что входит в цену, как возвращают залог и кто подписывает договор."
              />
              <Button
                type="button"
                disabled={launch === "checking"}
                onClick={() => openCityGo("housing")}
              >
                Продолжить в CityGo
              </Button>
              <Button
                type="button"
                variant="ghost"
                className={styles.quiet}
                onClick={back}
              >
                Уточнить условия
              </Button>
            </>
          )}
          {screen === "relocation" && (
            <>
              <div className={styles.heading}>
                <h1 ref={heading} tabIndex={-1}>
                  Оценить переезд
                </h1>
                <p>Разложите решение на расходы, сроки и ближайшие действия.</p>
              </div>
              <PlanCard
                title="С чего начать"
                detail="Запишите, какой доход ожидаете после переезда и сколько можете потратить в первый месяц."
                note
              />
              <Button
                type="button"
                disabled={launch === "checking"}
                onClick={() => openCityGo("coordinator")}
              >
                Продолжить в CityGo
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => changeScreen("housing")}
              >
                Найти жильё
              </Button>
            </>
          )}
          {launchNotice && (
            <p className={styles.notice} role="status">
              {launchNotice}
            </p>
          )}
        </main>
      )}
    </div>
  );
}

function TaskButton({
  title,
  detail,
  onClick,
}: {
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      className={styles.task}
      onClick={onClick}
    >
      <strong>{title}</strong>
      <span>{detail}</span>
    </Button>
  );
}

function PlanCard({
  title,
  detail,
  note = false,
}: {
  title: string;
  detail: string;
  note?: boolean;
}) {
  return (
    <Card className={`${styles.step} ${note ? styles.note : ""}`}>
      <h2>{title}</h2>
      <p>{detail}</p>
    </Card>
  );
}
