import { relocationStages } from "@citygo/contracts";

const labels: Record<(typeof relocationStages)[number], string> = {
  adaptation: "Адаптация",
  documents: "Документы",
  housing: "Жильё",
  profile: "Профиль",
  work: "Работа",
};

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <p className="eyebrow">CITYGO · ПЕРЕЕЗД БЕЗ ХАОСА</p>
        <h1>Ваш понятный маршрут в новом городе</h1>
        <p className="lead">
          Соберите персональный план переезда: от выбора района и работы до
          документов и первых недель после приезда.
        </p>
        <a href="#route">Собрать маршрут</a>
      </section>

      <section className="route" id="route" aria-labelledby="route-title">
        <div>
          <p className="eyebrow">ЕДИНЫЙ ПЛАН</p>
          <h2 id="route-title">Пять этапов, один спокойный переезд</h2>
        </div>
        <ol>
          {relocationStages.map((stage, index) => (
            <li key={stage}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {labels[stage]}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
