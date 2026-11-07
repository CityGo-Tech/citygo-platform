"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";
import { Card } from "@citygo/ui-web";
import { LandingBrand } from "./landing-brand";
import { LandingCta } from "./landing-cta";
import { productLegalHref } from "./landing-config";
import { LandingProductDemo } from "./landing-product-demo";
import styles from "./landing-v1.module.css";

function ResponsiveText({
  desktop,
  mobile,
}: {
  desktop: ReactNode;
  mobile: ReactNode;
}) {
  return (
    <>
      <span className={styles.desktopOnly}>{desktop}</span>
      <span className={styles.mobileOnly}>{mobile}</span>
    </>
  );
}

function InfoCard({
  overline,
  heading,
  body,
  tone = "white",
  className = "",
}: {
  overline?: ReactNode;
  heading: ReactNode;
  body: ReactNode;
  tone?: "white" | "soft" | "warm" | "canvas";
  className?: string;
}) {
  return (
    <Card className={`${styles.card} ${styles[tone]} ${className}`}>
      {overline && <p className={styles.cardOverline}>{overline}</p>}
      <h3>{heading}</h3>
      <p>{body}</p>
    </Card>
  );
}

const assistants = [
  {
    name: "Координатор",
    image: "/landing/coordinator.jpg",
    desktop: "От идеи до ближайшего шага",
    mobile: "От идеи до первого шага",
  },
  {
    name: "Жильё",
    image: "/landing/housing-assistant.jpg",
    desktop: "Поиск, бюджет и просмотры",
    mobile: "Бюджет и выбор района",
  },
  {
    name: "Работа",
    image: "/landing/work-assistant.jpg",
    desktop: "Стратегия поиска и подготовка",
    mobile: "Поиск и подготовка",
  },
  {
    name: "Резюме",
    image: "/landing/resume-assistant.jpg",
    desktop: "Опыт и отклик на вакансию",
    mobile: "Опыт и отклик",
  },
] as const;

const desktopFaq = [
  [
    "Я ещё не решил, переезжать ли. Мне подойдёт?",
    "Да. Можно обсудить ожидания, бюджет и ограничения. Решение остаться тоже может быть вашим итогом.",
  ],
  [
    "CityGo найдёт мне работу или квартиру?",
    "CityGo помогает подготовиться, сравнить варианты и наметить действия. Отклики, просмотры, договоры и окончательные решения остаются за вами.",
  ],
  [
    "Почему это лучше бесконечного поиска по чатам?",
    "Вместо разрозненных советов вы обсуждаете свою ситуацию и сохраняете нужные шаги. Сообщества остаются полезными для живого опыта и общения.",
  ],
  [
    "Можно ли доверять каждому ответу?",
    "Помощник может ошибаться. Перед оплатой жилья, заключением договора или важным решением проверяйте условия и первоисточники.",
  ],
  [
    "Как начать?",
    "Создайте аккаунт, подтвердите email и задайте свой вопрос. Для подарка потребуется подтвердить телефон.",
  ],
] as const;

const mobileFaq = [
  [
    "Я ещё думаю. Мне подойдёт?",
    "Да. Обсудите ожидания, возможности и ограничения. Решать, переезжать ли, будете вы.",
  ],
  [
    "Работа и квартира гарантированы?",
    "Нет. CityGo помогает разобраться и подготовиться. Условия и решения нужно проверять самостоятельно.",
  ],
  [
    "Как начать?",
    "Создайте аккаунт, подтвердите email и задайте вопрос. Для подарка подтвердите телефон.",
  ],
] as const;

function DemoVideo() {
  const [started, setStarted] = useState(false);
  return (
    <div className={styles.videoCard}>
      {started ? (
        <video
          className={styles.videoPlayer}
          controls
          autoPlay
          playsInline
          preload="none"
          aria-label="Демонстрация CityGo: вопрос, расчёт и сохранение шага"
        >
          <source src="/landing/citygo-demo.mp4" type="video/mp4" />
          Ваш браузер не поддерживает видео.{" "}
          <a href="/landing/citygo-demo.mp4">Открыть демонстрацию</a>.
        </video>
      ) : (
        <button
          className={styles.videoStart}
          onClick={() => setStarted(true)}
          type="button"
          aria-label="Смотреть демонстрацию CityGo — 42 секунды"
        >
          <span className={styles.videoTitle}>
            <ResponsiveText
              desktop={
                <>
                  От «хочу в Москву»
                  <br />к первому действию
                </>
              }
              mobile={
                <>
                  Как работает
                  <br />
                  CityGo
                </>
              }
            />
          </span>
          <span className={styles.videoThumbnail}>
            <Image
              src="/landing/coordinator.jpg"
              width={180}
              height={180}
              alt=""
              className={styles.videoPortrait}
            />
            <span className={styles.videoPlayCopy}>
              <span className={styles.playIcon} aria-hidden="true">
                ▶
              </span>
              <span className={styles.desktopOnly}>
                Как это выглядит в CityGo
                <br />
                Демонстрация · 42 секунды
              </span>
              <span className={styles.mobileOnly}>
                Демонстрация · 42 секунды
              </span>
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

export function LandingV1() {
  return (
    <div className={styles.page} data-citygo-public-landing="v1">
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a
            href="#v1-top"
            aria-label="CityGo — начало страницы"
            className={styles.headerBrand}
          >
            <span className={styles.desktopOnly}>
              <LandingBrand width={200} />
            </span>
            <span className={styles.mobileOnly}>
              <LandingBrand width={156} />
            </span>
          </a>
          <nav className={styles.navigation} aria-label="Навигация по странице">
            <a href="#benefits">Как помогает</a>
            <a href="#how-it-works">Как работает</a>
            <a href="#faq">Вопросы</a>
          </nav>
          <LandingCta
            variant="v1"
            placement="header"
            intent="login"
            secondary
            className={styles.headerCta}
          >
            <ResponsiveText desktop="Открыть CityGo" mobile="Войти" />
          </LandingCta>
        </div>
      </header>

      <main className={styles.main} id="v1-top">
        <section
          className={`${styles.section} ${styles.hero}`}
          aria-labelledby="v1-title"
        >
          <div className={styles.container}>
            <div className={styles.heroColumns}>
              <div className={styles.heroMessage}>
                <p className={styles.heroEyebrow}>ВАША СЛЕДУЮЩАЯ ГЛАВА</p>
                <h1 id="v1-title">
                  Мечта о Москве.
                  <br />
                  План — под
                  <br />
                  вашу жизнь.
                </h1>
                <p className={styles.heroDescription}>
                  <ResponsiveText
                    desktop={
                      <>
                        CityGo — ИИ-помощники по переезду.
                        <br />
                        Разберитесь с жильём, работой и бюджетом, чтобы решить,
                        подходит ли вам Москва и с чего начать.
                      </>
                    }
                    mobile="ИИ-помощники по переезду. Жильё, работа и бюджет — под вашу ситуацию."
                  />
                </p>
                <LandingCta
                  variant="v1"
                  placement="hero"
                  className={styles.cta}
                >
                  Разобрать мой переезд
                </LandingCta>
                <p className={styles.heroNote}>
                  <ResponsiveText
                    desktop={
                      <>
                        Можно начать без даты и точного бюджета.
                        <br />
                        Откроется CityGo — потребуется регистрация.
                      </>
                    }
                    mobile={
                      <>
                        Без даты и точного бюджета тоже можно.
                        <br />В CityGo потребуется регистрация.
                      </>
                    }
                  />
                </p>
              </div>
              <LandingProductDemo />
            </div>
            <div className={styles.topics} aria-label="Темы переезда">
              {[
                "Работа и доход",
                "Жильё и дорога",
                "Семья и быт",
                "Ваш следующий шаг",
              ].map((topic) => (
                <span key={topic}>{topic}</span>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.moscow} aria-labelledby="v1-moscow-title">
          <Image
            src="/landing/moscow-cc0-the-genji-2024.jpg"
            fill
            sizes="100vw"
            alt="Вид на Москву-реку и деловой центр Москвы"
          />
          <div className={styles.moscowShade} />
          <div className={`${styles.container} ${styles.moscowContent}`}>
            <p className={styles.eyebrow}>ВАША СЛЕДУЮЩАЯ ГЛАВА</p>
            <h2 id="v1-moscow-title">
              <ResponsiveText
                desktop={
                  <>
                    Не просто переехать.
                    <br />
                    Начать новую главу.
                  </>
                }
                mobile={
                  <>
                    Не просто
                    <br />
                    переехать.
                    <br />
                    Начать новую главу.
                  </>
                }
              />
            </h2>
            <p>Подготовка, на которую можно опереться.</p>
          </div>
        </section>

        <section
          className={styles.section}
          id="benefits"
          aria-labelledby="v1-benefits-title"
        >
          <div className={`${styles.container} ${styles.sectionStack}`}>
            <p className={`${styles.eyebrow} ${styles.desktopOnly}`}>
              БОЛЬШЕ ОПОРЫ
            </p>
            <h2 id="v1-benefits-title" className={styles.benefitsTitle}>
              <ResponsiveText
                desktop={
                  <>
                    Не просто больше информации.
                    <br />
                    Больше ясности для вашего решения.
                  </>
                }
                mobile={
                  <>
                    Больше ясности.
                    <br />
                    Меньше хаоса.
                  </>
                }
              />
            </h2>
            <p className={`${styles.intro} ${styles.desktopOnly}`}>
              Идея переезда может быть большой. Начать можно с одного понятного
              вопроса.
            </p>
            <div className={styles.threeColumns}>
              <InfoCard
                tone="soft"
                overline={
                  <ResponsiveText desktop="01 / УВЕРЕННОСТЬ" mobile="01" />
                }
                heading="Решение без спешки"
                body={
                  <ResponsiveText
                    desktop="Сопоставьте ожидания, возможности и ограничения. Переезжать сейчас или пока остаться — выбор за вами."
                    mobile="Понять, подходит ли вам Москва и что важно проверить до переезда."
                  />
                }
              />
              <InfoCard
                tone="warm"
                overline={
                  <ResponsiveText
                    desktop="02 / МЕНЬШЕ НЕОПРЕДЕЛЁННОСТИ"
                    mobile="02"
                  />
                }
                heading={
                  <ResponsiveText
                    desktop="План вместо хаоса"
                    mobile="Понятные шаги"
                  />
                }
                body={
                  <ResponsiveText
                    desktop="Свяжите жильё, работу, дорогу и семейные задачи в последовательность следующих действий."
                    mobile="Связать работу, жильё, дорогу и семейные задачи."
                  />
                }
              />
              <InfoCard
                tone="canvas"
                overline={
                  <ResponsiveText
                    desktop="03 / ВРЕМЯ И СПОКОЙСТВИЕ"
                    mobile="03"
                  />
                }
                heading={
                  <ResponsiveText
                    desktop="Важное — под рукой"
                    mobile="Важное под рукой"
                  />
                }
                body={
                  <ResponsiveText
                    desktop="Продолжайте диалог и сохраняйте полезные шаги. Не собирайте свой переезд заново каждый вечер."
                    mobile="Продолжать диалог и сохранять действия в своём плане."
                  />
                }
              />
            </div>
          </div>
        </section>

        <section
          className={`${styles.section} ${styles.canvas}`}
          id="scenarios"
          aria-labelledby="v1-scenarios-title"
        >
          <div className={`${styles.container} ${styles.sectionStack}`}>
            <p className={`${styles.eyebrow} ${styles.desktopOnly}`}>
              У КАЖДОГО СВОЙ ПЕРЕЕЗД
            </p>
            <h2 id="v1-scenarios-title">
              <ResponsiveText
                desktop="С чего начнём ваш?"
                mobile={
                  <>
                    У каждого
                    <br />
                    свой переезд.
                  </>
                }
              />
            </h2>
            <div className={styles.threeColumns}>
              <InfoCard
                overline={<span className={styles.desktopOnly}>РЕШЕНИЕ</span>}
                heading={
                  <ResponsiveText
                    desktop="«Пока только думаю»"
                    mobile="Пока только думаю"
                  />
                }
                body={
                  <ResponsiveText
                    desktop="Хочу понять, что изменится в жизни и сколько нужно на старт. Можно ли подготовиться, не увольняясь прямо сейчас?"
                    mobile="Сколько нужно на старт и что изменится в жизни?"
                  />
                }
              />
              <InfoCard
                overline={<span className={styles.desktopOnly}>СЕМЬЯ</span>}
                heading={
                  <ResponsiveText
                    desktop="«Переезжаем семьёй»"
                    mobile="Переезжаем семьёй"
                  />
                }
                body={
                  <ResponsiveText
                    desktop="Как связать жильё, работу родителей, школу и ежедневную дорогу — прежде чем выбирать район?"
                    mobile="Жильё, школа и дорога: как всё связать?"
                  />
                }
              />
              <InfoCard
                overline={<span className={styles.desktopOnly}>КАРЬЕРА</span>}
                heading={
                  <ResponsiveText
                    desktop="«Еду за возможностями»"
                    mobile="Еду за возможностями"
                  />
                }
                body={
                  <ResponsiveText
                    desktop="С чего начать поиск работы, как подготовить резюме и увязать будущий доход с бюджетом на жильё?"
                    mobile="С чего начать поиск работы и подготовку?"
                  />
                }
              />
            </div>
            <LandingCta
              variant="v1"
              placement="scenarios"
              className={styles.cta}
            >
              Разобрать мой переезд
            </LandingCta>
          </div>
        </section>

        <section
          className={styles.section}
          id="how-it-works"
          aria-labelledby="v1-product-title"
        >
          <div className={`${styles.container} ${styles.sectionStack}`}>
            <p className={`${styles.eyebrow} ${styles.desktopOnly}`}>
              ВНУТРИ CITYGO
            </p>
            <h2 id="v1-product-title">
              <ResponsiveText
                desktop={
                  <>
                    Ваш вопрос превращается
                    <br />в конкретный следующий шаг.
                  </>
                }
                mobile={
                  <>
                    От вопроса
                    <br />к следующему шагу.
                  </>
                }
              />
            </h2>
            <p className={styles.intro}>
              <ResponsiveText
                desktop="Ниже — пример работы с бюджетом: из ответа можно сохранить действие в «Мой план»."
                mobile="Спросите своими словами. Уточните детали с помощником. Сохраните действие в «Мой план»."
              />
            </p>
            <div className={`${styles.productColumns} ${styles.desktopOnly}`}>
              <LandingProductDemo />
              <div className={styles.steps}>
                <InfoCard
                  tone="soft"
                  overline="1"
                  heading="Спросите своими словами"
                  body="Не нужно заполнять длинную анкету. Опишите то, что сейчас волнует: бюджет, работу, район или переезд с детьми."
                />
                <InfoCard
                  tone="canvas"
                  overline="2"
                  heading="Обсудите детали"
                  body="Помощник уточняет вводные. В «Максимуме» для поиска актуальной информации могут появляться ссылки на источники."
                />
                <InfoCard
                  tone="warm"
                  overline="3"
                  heading="Сохраните важное"
                  body="Из ответа — в ваш план. Отмечайте выполненные действия и возвращайтесь к разговору, когда появятся новые вводные."
                />
              </div>
            </div>
            <div className={`${styles.mobilePlan} ${styles.mobileOnly}`}>
              <p className={styles.cardOverline}>МОЙ ПЛАН · В РАБОТЕ</p>
              <h3>Искать аренду до 54 000 ₽ в месяц</h3>
              <p>Уточнить залог, комиссию и платежи при заселении.</p>
            </div>
            <p className={`${styles.proofCaption} ${styles.mobileOnly}`}>
              Фрагмент реальной демонстрации от 04.11.2026. Это пример расчёта,
              а не цены всего рынка.
            </p>
          </div>
        </section>

        <section
          className={`${styles.section} ${styles.canvas}`}
          id="assistants"
          aria-labelledby="v1-assistants-title"
        >
          <div className={`${styles.container} ${styles.sectionStack}`}>
            <p className={`${styles.eyebrow} ${styles.desktopOnly}`}>
              НЕ НУЖНО РАЗБИРАТЬСЯ ОДНОМУ
            </p>
            <h2 id="v1-assistants-title">
              <ResponsiveText
                desktop="Выберите помощника под задачу."
                mobile={
                  <>
                    Ваша команда
                    <br />
                    помощников.
                  </>
                }
              />
            </h2>
            <div className={styles.assistantGrid}>
              {assistants.map((assistant) => (
                <Card key={assistant.name} className={styles.assistantCard}>
                  <Image
                    src={assistant.image}
                    width={254}
                    height={230}
                    alt=""
                    className={styles.assistantPortrait}
                  />
                  <div className={styles.assistantCopy}>
                    <h3>{assistant.name}</h3>
                    <p>
                      <ResponsiveText
                        desktop={assistant.desktop}
                        mobile={assistant.mobile}
                      />
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section
          className={styles.section}
          id="demo"
          aria-label="Видео о работе CityGo"
        >
          <div className={`${styles.container} ${styles.videoColumns}`}>
            <DemoVideo />
            <div className={`${styles.videoExplanation} ${styles.desktopOnly}`}>
              <h2>
                Посмотрите,
                <br />
                как работает CityGo.
              </h2>
              <p>
                Один вопрос о расходах на жильё, ответ с расчётом и сохранение
                следующего действия в план.
              </p>
              <p className={styles.videoFineprint}>
                Без обещаний найти квартиру за вас.
                <br />С ясным следующим шагом.
              </p>
            </div>
          </div>
        </section>

        <section
          className={`${styles.section} ${styles.soft}`}
          id="gift"
          aria-labelledby="v1-gift-title"
        >
          <div className={`${styles.container} ${styles.giftColumns}`}>
            <div className={styles.giftIntro}>
              <p className={`${styles.eyebrow} ${styles.desktopOnly}`}>
                ПОПРОБУЙТЕ НА СВОЕЙ СИТУАЦИИ
              </p>
              <h2 id="v1-gift-title">
                500 ₽ CityGo
                <br />
                на знакомство.
              </h2>
              <p>
                После регистрации и первого подтверждения телефона — по условиям
                подарка.
              </p>
              <LandingCta
                variant="v1"
                placement="gift"
                className={`${styles.cta} ${styles.desktopOnly}`}
              >
                Разобрать мой переезд
              </LandingCta>
            </div>
            <div className={styles.giftTerms}>
              <h3 className={styles.desktopOnly}>Что важно знать</h3>
              <p>
                <ResponsiveText
                  desktop="Это внутренний баланс для общения с помощниками. Вывести подарок деньгами нельзя."
                  mobile="Внутренний баланс для общения с помощниками. Один номер — один подарок. Вывести деньгами нельзя."
                />
              </p>
              <hr className={styles.desktopOnly} />
              <p className={styles.desktopOnly}>
                Один номер — один подарок. Если подарок уже получен, повторно он
                не начисляется.
              </p>
              <hr className={styles.desktopOnly} />
              <p>
                <ResponsiveText
                  desktop="Ответы оплачиваются с баланса CityGo. Стоимость зависит от режима; списание — после ответа."
                  mobile="Ответы оплачиваются с баланса. Стоимость зависит от режима. Списание — после ответа."
                />
              </p>
            </div>
            <LandingCta
              variant="v1"
              placement="gift-mobile"
              className={`${styles.cta} ${styles.mobileOnly}`}
            >
              Разобрать мой переезд
            </LandingCta>
          </div>
        </section>

        <section
          className={styles.section}
          id="faq"
          aria-labelledby="v1-faq-title"
        >
          <div className={`${styles.container} ${styles.sectionStack}`}>
            <p className={`${styles.eyebrow} ${styles.desktopOnly}`}>
              ОСТАЛИСЬ ВОПРОСЫ
            </p>
            <h2 id="v1-faq-title">
              <ResponsiveText
                desktop="Можно начать без готового решения."
                mobile={
                  <>
                    Можно начать
                    <br />с вопроса.
                  </>
                }
              />
            </h2>
            <div className={`${styles.faqList} ${styles.desktopOnly}`}>
              {desktopFaq.map(([question, answer]) => (
                <InfoCard
                  key={question}
                  className={styles.faqCard}
                  tone="canvas"
                  heading={question}
                  body={answer}
                />
              ))}
            </div>
            <div className={`${styles.faqList} ${styles.mobileOnly}`}>
              {mobileFaq.map(([question, answer]) => (
                <InfoCard
                  key={question}
                  tone="canvas"
                  heading={question}
                  body={answer}
                />
              ))}
            </div>
          </div>
        </section>

        <section
          className={`${styles.section} ${styles.closing}`}
          aria-labelledby="v1-closing-title"
        >
          <div className={`${styles.container} ${styles.sectionStack}`}>
            <h2 id="v1-closing-title">
              <ResponsiveText
                desktop={
                  <>
                    Мечта может стать ближе.
                    <br />
                    Начните с понятного шага.
                  </>
                }
                mobile={
                  <>
                    Мечта может
                    <br />
                    стать ближе.
                  </>
                }
              />
            </h2>
            <p>
              <ResponsiveText
                desktop="Расскажите, что сейчас больше всего волнует в переезде."
                mobile="Начните с понятного шага."
              />
            </p>
            <LandingCta
              variant="v1"
              placement="closing"
              className={`${styles.cta} ${styles.closingCta}`}
            >
              Разобрать мой переезд
            </LandingCta>
            <p className={`${styles.closingNote} ${styles.desktopOnly}`}>
              CityGo помогает разобраться. Решение всегда остаётся за вами.
            </p>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <LandingBrand width={170} />
          <nav
            className={styles.footerLinks}
            aria-label="Правовая информация и контакты"
          >
            <a href={productLegalHref()}>Политика конфиденциальности</a>
            <span className={styles.footerTerms}>
              <a href={productLegalHref()}>Условия сервиса</a>
              <span aria-hidden="true" className={styles.mobileOnly}>
                {" "}
                ·{" "}
              </span>
              <a href={productLegalHref()}>Условия подарка</a>
            </span>
            <a href={productLegalHref()}>Контакты</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
