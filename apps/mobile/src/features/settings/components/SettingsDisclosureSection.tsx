import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { ListRowLayout } from "../../../components/ListRowLayout";
import { RowPressable } from "../../../components/RowPressable";
import { SettingsSection } from "./SettingsSection";

/** Keeps less-used settings one tap away without saving a preference. */
export function SettingsDisclosureSection(props: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <SettingsSection>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={props.title}
        accessibilityHint={props.description}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
      >
        <ListRowLayout
          label={props.title}
          description={props.description}
          accessory={
            <SymbolView
              name={expanded ? "chevron.down" : "chevron.right"}
              size={16}
              tintColorClassName="accent-chevron"
              type="monochrome"
            />
          }
        />
      </RowPressable>
      {expanded ? (
        <View className="gap-4 border-t border-border-subtle p-4">{props.children}</View>
      ) : null}
    </SettingsSection>
  );
}
