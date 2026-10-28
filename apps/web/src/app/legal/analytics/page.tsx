import Link from "next/link";
import { AnalyticsPreference } from "../../../components/analytics-preference";
import styles from "../legal.module.css";

export const metadata = { title: "Аналитика сервиса — CityGo" };

export default function AnalyticsInformation() {
  return (
    <main className={styles.document}>
      <Link className={styles.brand} href="/">
        CityGo
      </Link>
      <article className={styles.paper}>
        <h1>Аналитика сервиса</h1>
        <p>
          Мы анализируем работу CityGo, чтобы находить ошибки и улучшать путь
          пользователя: регистрацию, подтверждение контактов, общение с
          помощниками, сохранение материалов и пополнение баланса.
        </p>
        <h2>События и записи посещений</h2>
        <p>
          При включённой аналитике Яндекс.Метрика получает технические сведения
          о посещении, переходах, кликах и прокрутке. Для связи посещений
          используются cookie и технический идентификатор; email и номер
          телефона в качестве этого идентификатора не передаются.
        </p>
        <p>
          Тексты диалогов, личные материалы, содержимое полей ввода, пароли,
          коды подтверждения и платёжные реквизиты исключаются из событий
          Метрики. Личные блоки скрываются от записи Вебвизора. В
          административной части приложения счётчик не загружается.
        </p>
        <h2>Материалы аккаунта</h2>
        <p>
          Отправленные сообщения и ответы помощников, сведения аккаунта,
          сохранённые материалы и операции баланса хранятся в CityGo для работы
          сервиса. Уполномоченный супер-администратор может просмотреть эти
          сведения для поддержки пользователя и разбора ошибок. Такие просмотры
          фиксируются в журнале доступа. Просмотр не даёт администратору сессию
          пользователя и не выполняет действия от его имени.
        </p>
        <AnalyticsPreference />
        <p>
          Блокировка счётчика средствами браузера не мешает основным функциям
          CityGo. Оператор: ИП Суриков Дмитрий Андреевич. Вопросы об обработке
          данных можно направить на{" "}
          <a href="mailto:citygo.rf@gmail.com">citygo.rf@gmail.com</a>.
        </p>
        <p>
          <a
            href="https://yandex.ru/support/metrica/ru/general/cookie-usage"
            target="_blank"
            rel="noreferrer"
          >
            О cookie Яндекс.Метрики
          </a>
          {" · "}
          <a
            href="https://yandex.ru/support/metrica/ru/webvisor/requirements"
            target="_blank"
            rel="noreferrer"
          >
            Записи Вебвизора и сроки хранения
          </a>
        </p>
      </article>
      <Link className={styles.back} href="/legal">
        К документам CityGo
      </Link>
    </main>
  );
}
