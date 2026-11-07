import { Card } from "@citygo/ui-web";
import { LandingBrand } from "./landing-brand";
import { LandingExampleBackLink } from "./landing-example-back-link";
import {
  landingExamples,
  type LandingExampleKey,
} from "./landing-example-data";
import styles from "./landing-example.module.css";

export {
  landingExampleKeys,
  type LandingExampleKey,
} from "./landing-example-data";

export function LandingExample({ example }: { example: LandingExampleKey }) {
  const data = landingExamples[example];
  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <LandingBrand width={145} />
        <LandingExampleBackLink className={styles.back}>
          ← К CityGo
        </LandingExampleBackLink>
        <p className={styles.provenance}>{data.provenance}</p>
        <h1>{data.title}</h1>
        <Card className={styles.summary}>
          <p className={styles.overline}>РЕДАКТОРСКОЕ РЕЗЮМЕ</p>
          <h2>Что получилось</h2>
          <p>{data.summary}</p>
        </Card>
        <section
          className={styles.textSection}
          aria-labelledby="example-question"
        >
          <h2 id="example-question">Полный вопрос</h2>
          <p>{data.question}</p>
        </section>
        <section
          className={styles.textSection}
          aria-labelledby="example-answer"
        >
          <h2 id="example-answer">{data.answerHeading}</h2>
          <div className={styles.answer}>
            {data.answerParagraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </section>
        {data.savedStep && (
          <section
            className={styles.savedStep}
            aria-labelledby="saved-step-title"
          >
            <h2 id="saved-step-title">{data.savedStep.heading}</h2>
            <p className={styles.savedLabel}>{data.savedStep.label}</p>
            <h3>{data.savedStep.title}</h3>
            <p>{data.savedStep.description}</p>
            <p className={styles.savedStatus}>{data.savedStep.status}</p>
            <p>{data.savedStep.returnToAnswer}</p>
            <p className={styles.boundary}>{data.savedStep.boundary}</p>
          </section>
        )}
        <h2 className={styles.nextHeading}>{data.nextHeading}</h2>
        <p className={styles.nextAction}>{data.nextAction}</p>
        <LandingExampleBackLink className={styles.back}>
          Вернуться к CityGo
        </LandingExampleBackLink>
      </article>
    </main>
  );
}
