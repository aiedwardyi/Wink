import { useState } from "react";
import { applyGeometry, readGeometry, type Geometry } from "@/lib/geometry";
import { useI18n } from "@/lib/i18n";
import { Segmented } from "./Segmented";

export function GeometryPicker() {
  const { t } = useI18n();
  const [geometry, setGeometry] = useState(readGeometry);
  return (
    <Segmented<Geometry>
      label={t("settings.shape.title")}
      title={t("settings.shape.title")}
      value={geometry}
      options={(["soft", "boxy"] as const).map((id) => ({ id, label: t(`settings.shape.${id}`) }))}
      onChange={(value) => { applyGeometry(value); setGeometry(value); }}
    />
  );
}
