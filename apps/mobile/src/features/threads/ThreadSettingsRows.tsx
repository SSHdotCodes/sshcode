import { View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import {
  ModelRowContent,
  ChoiceRowContent,
  type ModelRowProps,
  type ChoiceRowProps,
} from "./ThreadSettingsRows.shared";

function SelectedCheckmark(props: { readonly selected: boolean }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="w-[16px] shrink-0 items-center"
    >
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColorClassName="accent-primary"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </View>
  );
}

export function ModelRow(props: ModelRowProps) {
  return (
    <ModelRowContent
      {...props}
      labelNumberOfLines={2}
      selectedClassName={props.selected ? "bg-secondary" : undefined}
      trailingSelection={<SelectedCheckmark selected={props.selected} />}
    />
  );
}

export function ChoiceRow(props: ChoiceRowProps) {
  return (
    <ChoiceRowContent
      {...props}
      trailingSelection={<SelectedCheckmark selected={props.selected} />}
    />
  );
}
