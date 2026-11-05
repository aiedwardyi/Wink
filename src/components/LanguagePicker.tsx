// App-language control. English and Korean are first-class; "Match this
// computer" keeps following the OS until the person picks one explicitly.
import { useI18n, type LocalePreference } from "@/lib/i18n";
import { SegmentedRow } from "./Segmented";
import { Card } from "./SettingsPrimitives";

const OPTIONS: LocalePreference[] = ["system", "en", "ko"];

export function LanguagePicker() {
  const { t, preference, setPreference } = useI18n();
  return (
    <Card>
      <SegmentedRow<LocalePreference>
        label={t("language.title")}
        value={preference}
        options={OPTIONS.map((id) => ({
          id, label: id === "system" ? t("language.matchSystem") : id === "en" ? t("language.name.en") : t("language.name.ko"),
        }))}
        onChange={setPreference}
      />
    </Card>
  );
}
