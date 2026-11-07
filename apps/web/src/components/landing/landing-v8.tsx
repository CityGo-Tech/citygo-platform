import { Card } from "@citygo/ui-web";
import type { ReactNode } from "react";
import { LandingBrand } from "./landing-brand";
import { LandingCta } from "./landing-cta";
import { productLegalHref } from "./landing-config";
import { LandingExampleLink } from "./landing-example-link";
import type { LandingExampleKey } from "./landing-example-data";
import styles from "./landing-v8.module.css";

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

const faq = [
  [
    "Можно начать без даты, бюджета и оффера?",
    "Да. Начните с известных условий и своего вопроса. Ехать, подготовиться или остаться — выбор за вами.",
  ],
  [
    "CityGo найдёт квартиру, работу или место в школе?",
    "Помощники выделяют вопросы и зависимости на ваших вводных. Конкретные условия и договорённости нужно подтвердить самостоятельно.",
  ],
  [
    "Как попробовать и сколько стоит?",
    "500 ₽ CityGo — после первого подтверждения телефона. В демо 7 ноября — 11,68–20,09 ₽ за ответ; это примеры. Ваша цена зависит от режима и объёма, списание — после ответа. Подарок нельзя вывести деньгами.",
  ],
] as const;

const exampleLinkContext = {
  decision: "решение о переезде",
  family: "семья и жильё",
  income: "деньги до первой зарплаты",
  cost: "платежи при аренде",
  plan: "сохранённый шаг",
} as const;

function FullExampleLink({ example }: { example: LandingExampleKey }) {
  return (
    <LandingExampleLink example={example} className={styles.exampleLink}>
      Вводные и полный разбор ↗
      <span className={styles.srOnly}> — {exampleLinkContext[example]}</span>
    </LandingExampleLink>
  );
}

function DecisionDemo() {
  return (
    <div className={styles.decisionDemo}>
      <h2>
        <ResponsiveText
          desktop="Больше зарплата — больше свободных денег?"
          mobile={
            <>
              Зарплата выше.
              <br />А сколько остаётся?
            </>
          }
        />
      </h2>
      <p className={styles.caption}>Условный пример · суммы в месяц</p>
      <div className={styles.comparison}>
        <div className={styles.consequence} data-landing-result="decision">
          <ResponsiveText
            desktop={
              <>
                Зарплата выше на 50 000 ₽.
                <br />
                Свободных денег — на 7 000 ₽ меньше.
              </>
            }
            mobile={
              <>
                В Москве остаётся
                <br />
                на 7 000 ₽/мес меньше.
              </>
            }
          />
        </div>
        <div className={styles.budgets}>
          <div className={styles.budget}>
            <h3>
              <ResponsiveText
                desktop="Свой город"
                mobile="Дома · своя квартира"
              />
            </h3>
            <p className={styles.desktopOnly}>
              Доход 95 000 ₽<br />
              Расходы 55 000 ₽
            </p>
            <p className={styles.monthlyResult}>
              <ResponsiveText
                desktop="40 000 ₽"
                mobile="95 000 − 55 000 = 40 000 ₽"
              />
            </p>
            <p className={`${styles.caption} ${styles.desktopOnly}`}>
              Остаётся в месяц; квартира своя
            </p>
          </div>
          <div className={styles.budget}>
            <h3>Москва</h3>
            <p className={styles.desktopOnly}>
              Доход 145 000 ₽<br />
              Расходы 112 000 ₽
            </p>
            <p className={styles.monthlyResult}>
              <ResponsiveText
                desktop="33 000 ₽"
                mobile="145 000 − 112 000 = 33 000 ₽"
              />
            </p>
            <p className={`${styles.caption} ${styles.desktopOnly}`}>
              Остаётся в месяц
            </p>
          </div>
        </div>
      </div>
      <p className={styles.decisionBoundary}>
        <ResponsiveText
          desktop="Это денежная часть сравнения. Карьерные и личные причины оцениваются отдельно."
          mobile="Деньги — часть решения. Карьерные и личные причины отдельно."
        />
      </p>
      <p className={styles.caption}>
        <ResponsiveText
          desktop="Реальный ответ CityGo · редакторское сокращение · 07.11.2026"
          mobile="Реальный ответ · условный пример · 07.11.2026"
        />
      </p>
      <FullExampleLink example="decision" />
    </div>
  );
}

export function LandingV8() {
  return (
    <div className={styles.page} data-citygo-public-landing="v8" id="v8-top">
      <header className={styles.header}>
        <div className={`${styles.container} ${styles.headerInner}`}>
          <a
            href="#v8-top"
            aria-label="Ситиго — начало страницы"
            className={styles.brandLink}
          >
            <span className={styles.desktopOnly}>
              <LandingBrand width={200} />
            </span>
            <span className={styles.mobileOnly}>
              <LandingBrand width={158} />
            </span>
          </a>
          <LandingCta
            variant="v8"
            placement="header"
            intent="login"
            secondary
            className={styles.login}
          >
            Войти
          </LandingCta>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="v8-title">
          <div className={`${styles.container} ${styles.heroColumns}`}>
            <div className={styles.heroMessage}>
              <p className={styles.eyebrow}>
                CITYGO · ИИ-ПОМОЩНИКИ ДЛЯ ПЕРЕЕЗДА
              </p>
              <h1 id="v8-title">
                Переезд в Москву.
                <br />
                Поймите свои варианты.
              </h1>
              <p className={styles.heroDescription}>
                <ResponsiveText
                  desktop="Сравните расходы и условия жизни, свяжите жильё, работу и семейные задачи. ИИ-помощники CityGo помогут разобрать ваши вводные и сохранить нужные действия в плане."
                  mobile="ИИ-помощники по переезду: сравните расходы, жильё и семейные условия. Сохраните выбранные действия в своём плане."
                />
              </p>
              <LandingCta variant="v8" placement="hero" className={styles.cta}>
                Начать свой разбор
              </LandingCta>
              <p className={styles.entryNote}>
                <ResponsiveText
                  desktop="Откроется CityGo: войдите или создайте аккаунт."
                  mobile="Вход или регистрация в CityGo."
                />
              </p>
              <p className={styles.entryNote}>
                <ResponsiveText
                  desktop="500 ₽ CityGo после первого подтверждения телефона. Для общения с помощниками; один номер — один подарок."
                  mobile="500 ₽ CityGo — после первого подтверждения телефона. Один номер — один подарок."
                />
              </p>
            </div>
            <DecisionDemo />
          </div>
        </section>

        <section
          className={styles.examples}
          id="scenarios"
          aria-labelledby="v8-examples-title"
        >
          <div className={`${styles.container} ${styles.sectionStack}`}>
            <h2 id="v8-examples-title">
              Посмотрите, что можно понять
              <br />
              на своих вводных
            </h2>
            <p className={styles.muted}>
              Реальные ответы CityGo на условные ситуации. Суммы и маршруты
              заданы для примеров, это не текущие предложения рынка.
            </p>
            <div className={styles.caseGrid}>
              <Card className={`${styles.caseCard} ${styles.family}`}>
                <p className={styles.eyebrow}>
                  <ResponsiveText
                    desktop="СЕМЬЯ И ЖИЛЬЁ"
                    mobile="СЕМЬЯ · ПРИМЕР 07.11.2026"
                  />
                </p>
                <h3>
                  <ResponsiveText
                    desktop={
                      <>
                        Квартира дешевле.
                        <br />А ежедневная жизнь?
                      </>
                    }
                    mobile={
                      <>
                        Аренда дороже.
                        <br />
                        Дорога вдвое короче.
                      </>
                    }
                  />
                </h3>
                <p>
                  <ResponsiveText
                    desktop={
                      <>
                        А: аренда 58 тыс. ₽; работа 70 мин; школа 20 мин пешком.
                        <br />
                        Б: аренда 68 тыс. ₽; работа 35 мин; школа 10 мин пешком.
                      </>
                    }
                    mobile={
                      <>
                        А: 58 тыс. ₽; работа 70 мин.
                        <br />
                        Б: 68 тыс. ₽; работа 35 мин.
                      </>
                    }
                  />
                </p>
                <p className={styles.caption}>
                  <ResponsiveText
                    desktop="Работа — в одну сторону. Места в школе ещё не подтверждены."
                    mobile="Дорога до работы — в одну сторону."
                  />
                </p>
                <div className={styles.caseResult}>
                  <ResponsiveText
                    desktop={
                      <>
                        +10 тыс. ₽ аренды.
                        <br />
                        −35 мин до работы.
                      </>
                    }
                    mobile={
                      <>
                        Место в школе
                        <br />
                        нужно подтвердить.
                      </>
                    }
                  />
                </div>
                <p className={styles.desktopOnly}>
                  Школьное преимущество зависит от зачисления именно в нужный
                  корпус.
                </p>
                <p>
                  <ResponsiveText
                    desktop="До аванса уточнить наличие мест в нужном классе и корпусе."
                    mobile="До аванса уточнить нужный класс и корпус."
                  />
                </p>
                <p className={`${styles.caption} ${styles.desktopOnly}`}>
                  Реальный разбор · условные вводные · 07.11.2026
                </p>
                <FullExampleLink example="family" />
              </Card>

              <Card className={`${styles.caseCard} ${styles.income}`}>
                <p className={styles.eyebrow}>
                  <ResponsiveText
                    desktop="РАБОТА И ДЕНЬГИ НА СТАРТ"
                    mobile="РАБОТА · ПРИМЕР 07.11.2026"
                  />
                </p>
                <h3>
                  <ResponsiveText
                    desktop={
                      <>
                        Оффер есть.
                        <br />
                        Хватит ли денег до зарплаты?
                      </>
                    }
                    mobile={
                      <>
                        До первой зарплаты
                        <br />
                        тоже нужно на что-то жить.
                      </>
                    }
                  />
                </h3>
                <p>
                  <ResponsiveText
                    desktop={
                      <>
                        Накоплено 200 тыс. ₽.
                        <br />
                        Въезд — 170 тыс. ₽, включая первую аренду.
                        <br />
                        До первой зарплаты через 30 дней — ещё 60 тыс. ₽, без
                        аванса.
                      </>
                    }
                    mobile={
                      <>
                        Есть 200 тыс. ₽. Въезд — 170 тыс. ₽.
                        <br />
                        До зарплаты через 30 дней — ещё 60 тыс. ₽, без аванса.
                      </>
                    }
                  />
                </p>
                <p className={styles.caption}>
                  <ResponsiveText
                    desktop="Первую аренду повторно не считаем."
                    mobile="Первая аренда уже включена во въезд."
                  />
                </p>
                <div className={styles.caseResult}>Не хватает 30 000 ₽.</div>
                <p className={styles.desktopOnly}>
                  200 − 170 − 60 = −30 тыс. ₽. Размер зарплаты не закрывает
                  разрыв до её выплаты.
                </p>
                <p>
                  <ResponsiveText
                    desktop="Обсудить с работодателем помощь на переезд до выхода на работу."
                    mobile="Обсудить помощь на переезд до первой выплаты."
                  />
                </p>
                <p className={`${styles.caption} ${styles.desktopOnly}`}>
                  Реальный разбор · условные вводные · 07.11.2026
                </p>
                <FullExampleLink example="income" />
              </Card>

              <Card className={`${styles.caseCard} ${styles.cost}`}>
                <p className={styles.eyebrow}>
                  <ResponsiveText
                    desktop="ПЛАТЕЖИ ПРИ АРЕНДЕ"
                    mobile="ЖИЛЬЁ И ПЛАН · ПРИМЕР 04.11.2026"
                  />
                </p>
                <h3>
                  <ResponsiveText
                    desktop={
                      <>
                        65 тысяч за аренду.
                        <br />
                        Сколько нужно на первый месяц?
                      </>
                    }
                    mobile={
                      <>
                        Аренда — 65 тысяч.
                        <br />
                        Первый месяц — 168,5 тысячи.
                      </>
                    }
                  />
                </h3>
                <p>
                  <ResponsiveText
                    desktop="Аренда 65 000 ₽ + залог 65 000 ₽ + комиссия 50% от аренды (32 500 ₽) + коммунальные 6 000 ₽."
                    mobile="65 аренда + 65 залог + 32,5 комиссия (50% от аренды) + 6 коммунальные — в тыс. ₽."
                  />
                </p>
                <p className={styles.caption}>
                  <ResponsiveText
                    desktop="Условные платежи, не рыночная оценка."
                    mobile="Условные платежи, не цены рынка."
                  />
                </p>
                <div className={`${styles.caseResult} ${styles.desktopOnly}`}>
                  168 500 ₽ в первый месяц.
                </div>
                <p>
                  <ResponsiveText
                    desktop="Далее — 71 000 ₽/мес. При всём месячном бюджете 60 000 ₽, включая 6 000 ₽ коммунальных, предел аренды — 54 000 ₽."
                    mobile="Если бюджет — 60 тыс. ₽/мес, включая коммунальные 6 тыс. ₽:"
                  />
                </p>
                <LandingExampleLink example="plan" className={styles.savedStep}>
                  <span>Сохранено в «Моём плане»</span>
                  <strong>Искать аренду до 54 000 ₽ в месяц</strong>
                </LandingExampleLink>
                <p className={styles.desktopOnly}>
                  Шаг можно открыть и вернуться к исходному ответу.
                </p>
                <p className={`${styles.caption} ${styles.desktopOnly}`}>
                  Реальный разбор · условные вводные · 04.11.2026
                </p>
                <FullExampleLink example="cost" />
              </Card>
            </div>
          </div>
        </section>

        <section
          className={styles.stepsSection}
          id="how-it-works"
          aria-labelledby="v8-steps-title"
        >
          <div className={`${styles.container} ${styles.shortStack}`}>
            <h2 id="v8-steps-title">
              <ResponsiveText
                desktop="Свой вопрос → разбор → выбранный шаг"
                mobile="Вопрос → разбор → свой шаг"
              />
            </h2>
            <ol className={styles.steps}>
              <li>
                <span>01</span>
                <div>
                  <h3>
                    <ResponsiveText
                      desktop="Расскажите о своей ситуации"
                      mobile="Задайте свой вопрос"
                    />
                  </h3>
                  <p className={styles.desktopOnly}>
                    Войдите в CityGo и выберите тему: решение о переезде, жильё,
                    работа или резюме.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>
                    <ResponsiveText
                      desktop="Уточните, что важно именно вам"
                      mobile="Уточните детали"
                    />
                  </h3>
                  <p className={styles.desktopOnly}>
                    Добавляйте бюджет, сроки и ограничения по ходу разговора.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>
                    <ResponsiveText
                      desktop="Сохраните полезные действия"
                      mobile="Сохраните полезное"
                    />
                  </h3>
                  <p className={styles.desktopOnly}>
                    Нужные пункты оставьте в «Моём плане», чтобы продолжить
                    подготовку позже.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section
          className={styles.faqSection}
          id="faq"
          aria-labelledby="v8-faq-title"
        >
          <div className={`${styles.container} ${styles.shortStack}`}>
            <h2 id="v8-faq-title">Перед первым разбором</h2>
            <div className={styles.faqGrid}>
              {faq.map(([question, answer]) => (
                <div className={styles.faqItem} key={question}>
                  <h3>{question}</h3>
                  <p>{answer}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="v8-closing-title">
          <div className={`${styles.container} ${styles.closingColumns}`}>
            <div className={styles.closingCopy}>
              <h2 id="v8-closing-title">
                <ResponsiveText
                  desktop={
                    <>
                      Разберите вопрос,
                      <br />
                      который мешает двигаться дальше.
                    </>
                  }
                  mobile="Начните со своих условий."
                />
              </h2>
              <p>
                <ResponsiveText
                  desktop="Решение, семья, работа или жильё — начните со своей ситуации."
                  mobile="Свой вопрос — свой следующий шаг."
                />
              </p>
            </div>
            <div className={styles.closingAction}>
              <LandingCta
                variant="v8"
                placement="closing"
                className={styles.cta}
              >
                Начать свой разбор
              </LandingCta>
              <p className={styles.entryNote}>
                <ResponsiveText
                  desktop="Откроется CityGo: войдите или создайте аккаунт."
                  mobile="Вход или регистрация в CityGo."
                />
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerInner}`}>
          <LandingBrand width={128} />
          <nav
            className={styles.footerLinks}
            aria-label="Правовая информация и контакты"
          >
            <a href={productLegalHref()}>Условия сервиса</a>
            <a href={productLegalHref()}>Конфиденциальность</a>
            <a href={productLegalHref()}>Контакты</a>
            <a href={productLegalHref()}>Условия подарка</a>
          </nav>
          <p>
            Подарок используется для общения с помощниками. Вывести деньгами
            нельзя.
          </p>
        </div>
      </footer>
    </div>
  );
}
