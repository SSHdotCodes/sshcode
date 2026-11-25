import { AppText as Text } from "../../components/AppText";

/** Keep the status and a useful preview together on one truncating line. */
export function ThreadRowStatusText(props: {
  readonly status?: string | null | undefined;
  readonly preview?: string | null | undefined;
  readonly error?: string | undefined;
  readonly className: string;
  readonly previewClassName?: string | undefined;
}) {
  const { status, preview, error } = props;
  return (
    <Text className={props.className} numberOfLines={1}>
      {error ? (status ? `${status} · ${error}` : error) : (status ?? preview)}
      {!error && status && preview && status !== preview ? (
        <Text className={props.previewClassName}>{` · ${preview}`}</Text>
      ) : null}
    </Text>
  );
}
