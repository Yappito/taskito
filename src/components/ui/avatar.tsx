import Image from "next/image";
import { cn } from "@/lib/utils";
import { getUserImageUrl, getUserInitials } from "@/lib/user-image";

interface AvatarProps {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeClasses = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-7 w-7 text-[10px]",
  md: "h-9 w-9 text-xs",
  lg: "h-14 w-14 text-sm",
  xl: "h-24 w-24 text-xl",
} as const;

export function Avatar({ name, email, image, size = "md", className }: AvatarProps) {
  const imageUrl = getUserImageUrl(image);
  const initials = getUserInitials(name, email);
  const label = name?.trim() || email?.trim() || "User";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border font-semibold uppercase tracking-[0.08em]",
        sizeClasses[size],
        className
      )}
      style={{
        borderColor: "color-mix(in srgb, var(--color-accent) 30%, var(--color-border))",
        background:
          "radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--color-accent) 25%, white), color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-muted)) 55%, color-mix(in srgb, var(--color-accent) 18%, var(--color-bg-overlay)))",
        color: "var(--color-accent)",
      }}
      aria-label={label}
      title={label}
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={label}
          fill
          unoptimized
          sizes="96px"
          className="object-cover"
        />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}