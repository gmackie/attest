import {
  FirstAidKitIcon,
  GraduationCapIcon,
  TruckIcon,
  SealCheckIcon,
} from "@phosphor-icons/react";
export const IndustryIcon = ({
  id,
  size = 28,
}: {
  id: string;
  size?: number;
}) =>
  id === "healthcare" ? (
    <FirstAidKitIcon size={size} />
  ) : id === "education" ? (
    <GraduationCapIcon size={size} />
  ) : id === "logistics" ? (
    <TruckIcon size={size} />
  ) : (
    <SealCheckIcon size={size} />
  );
