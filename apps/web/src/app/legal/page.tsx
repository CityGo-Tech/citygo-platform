import Link from "next/link";
import { serviceConsentPolicy } from "@citygo/contracts";
import styles from "./legal.module.css";

export const metadata = { title: "Документы — CityGo" };

export default function LegalDocuments() {
  return (
    <main className={styles.document}>
      <Link className={styles.brand} href="/">
        CityGo
      </Link>
      <article className={styles.paper}>
        <h1>Документы CityGo</h1>
        <p>Условия обработки данных CityGo. Рассылка добровольная.</p>
        <ul className={styles.links}>
          <li>
            <Link href={serviceConsentPolicy.personalData.url}>
              Согласие на обработку персональных данных
            </Link>
          </li>
          <li>
            <Link href={serviceConsentPolicy.marketing.url}>
              Согласие на рекламную рассылку
            </Link>
          </li>
          <li>
            <a href="https://app.xn--c1ajazlh.xn--p1ai/legal">
              Другие документы сервиса
            </a>
          </li>
        </ul>
        <p>
          Вопросы и отзыв согласия:{" "}
          <a href="mailto:citygo.rf@gmail.com">citygo.rf@gmail.com</a>.
        </p>
      </article>
      <Link className={styles.back} href="/">
        Вернуться в CityGo
      </Link>
    </main>
  );
}
