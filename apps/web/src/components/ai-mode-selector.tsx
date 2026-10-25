"use client";
import * as React from "react";
import { SelectField } from "@citygo/ui-web";
import { aiModeIdSchema, type AiModeId, type AiModes } from "@citygo/contracts";

export function AiModeSelector({
  modes,
  selected,
  disabled,
  onSelect,
}: {
  modes?: AiModes;
  selected: AiModeId;
  disabled: boolean;
  onSelect: (mode: AiModeId) => void;
}) {
  if (!modes) return null;
  return (
    <SelectField
      label="Режим ответа"
      value={selected}
      disabled={disabled}
      onChange={(event) => {
        const mode = aiModeIdSchema.safeParse(event.target.value);
        if (
          !disabled &&
          mode.success &&
          modes.options.some(
            (option) => option.id === mode.data && option.available,
          )
        )
          onSelect(mode.data);
      }}
    >
      {modes.options.map((option) => (
        <option key={option.id} value={option.id} disabled={!option.available}>
          {option.label}
          {!option.available ? " — временно недоступен" : ""}
        </option>
      ))}
    </SelectField>
  );
}
