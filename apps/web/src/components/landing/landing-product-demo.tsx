import Image from "next/image";
import { LandingBrand } from "./landing-brand";
import styles from "./landing-product-demo.module.css";

/** Native reconstruction of the editable product example in the V1 design. */
export function LandingProductDemo({ className = "" }: { className?: string }) {
  return (
    <div
      className={`${styles.demo} ${className}`}
      aria-label="Пример интерфейса CityGo"
    >
      <div className={styles.navigation}>
        <LandingBrand width={120} />
        <span>Диалоги&nbsp;&nbsp; · &nbsp;&nbsp;Мой план</span>
      </div>
      <div className={styles.divider} />
      <div className={styles.assistant}>
        <Image src="/landing/coordinator.jpg" width={64} height={64} alt="" />
        <p>
          Координатор переезда
          <br />
          Давайте начнём с того, что волнует
        </p>
      </div>
      <div className={`${styles.bubble} ${styles.question}`}>
        <p className={styles.label}>Вы</p>
        <p>
          Бюджет на жильё — 60 000 ₽.
          <br />
          Аренда 65 000 ₽: во сколько обойдётся въезд?
        </p>
      </div>
      <div className={`${styles.bubble} ${styles.answer}`}>
        <p className={styles.label}>Помощник по жилью</p>
        <p className={styles.answerMain}>
          При таких вводных первый месяц — 168 500 ₽.
          <br />
          Далее — 71 000 ₽ в месяц с коммунальными.
        </p>
        <p className={styles.answerDetail}>
          Чтобы уложиться в 60 000 ₽ с коммунальными, искать аренду до 54 000 ₽
          и уточнить залог и комиссию.
        </p>
      </div>
      <div className={`${styles.bubble} ${styles.saved}`}>
        <p className={styles.savedLabel}>В МОЁМ ПЛАНЕ</p>
        <p className={styles.savedTitle}>Искать аренду до 54 000 ₽ в месяц</p>
      </div>
      <p className={styles.caption}>
        Пример из записи CityGo: залог 65 000 ₽, комиссия 50%, коммунальные 6
        000 ₽. Суммы зависят от вводных, а не отражают весь рынок.
      </p>
    </div>
  );
}
