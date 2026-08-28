import { CATEGORIES, categoryName } from "@/lib/finance/categories";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const GROUPS: Array<{ id: string; label: string }> = [
  { id: "living", label: "Living" },
  { id: "lifestyle", label: "Lifestyle" },
  { id: "income", label: "Income" },
  { id: "money", label: "Money" },
];

export function CategorySelect({
  value,
  onChange,
  placeholder = "Category",
  className,
  size = "default",
}: {
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  size?: "default" | "sm";
}) {
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger
        className={cn(
          size === "sm" && "h-9 px-2.5 text-sm",
          !value && "text-muted-foreground",
          className,
        )}
        aria-label="Category"
      >
        <span className="line-clamp-1">
          {value ? categoryName(value) : placeholder}
        </span>
      </SelectTrigger>
      <SelectContent>
        {GROUPS.map((group) => (
          <SelectGroup key={group.id}>
            <SelectLabel>{group.label}</SelectLabel>
            {CATEGORIES.filter((c) => c.group === group.id).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
