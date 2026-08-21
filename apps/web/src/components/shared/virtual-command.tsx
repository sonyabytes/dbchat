import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SearchIcon } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export interface VirtualCommandItem {
  id: string;
  /** Text used by both cmdk and the large-list substring filter. */
  search: string;
  /** Deferred so large menus only create React elements for visible rows. */
  render: () => ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export interface VirtualCommandSection {
  id: string;
  heading: string;
  items: ReadonlyArray<VirtualCommandItem>;
}

interface VirtualCommandProps {
  sections: ReadonlyArray<VirtualCommandSection>;
  placeholder: string;
  emptyMessage?: string;
  className?: string;
}

const VIRTUALIZE_AT = 100;
const ROW_PX = 32;

type VirtualRow =
  | { kind: "heading"; id: string; heading: string; first: boolean }
  | { kind: "item"; id: string; item: VirtualCommandItem };

const normalizedSearch = new WeakMap<VirtualCommandItem, string>();

function matches(item: VirtualCommandItem, words: ReadonlyArray<string>): boolean {
  if (words.length === 0) return true;
  let haystack = normalizedSearch.get(item);
  if (haystack === undefined) {
    haystack = item.search.toLocaleLowerCase();
    normalizedSearch.set(item, haystack);
  }
  return words.every((word) => haystack.includes(word));
}

/**
 * Keeps cmdk's normal fuzzy matching for small menus. Once a menu becomes
 * large, filtering is done against the data model and only the visible rows
 * are mounted. This avoids cmdk scoring and rendering hundreds of DOM nodes on
 * every keystroke while preserving its selection and dialog semantics.
 */
export function VirtualCommand({
  sections,
  placeholder,
  emptyMessage = "No matches.",
  className,
}: VirtualCommandProps) {
  const itemCount = sections.reduce((total, section) => total + section.items.length, 0);

  if (itemCount < VIRTUALIZE_AT) {
    return (
      <Command loop className={cn("bg-transparent p-0", className)}>
        <CommandInput placeholder={placeholder} autoFocus />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>{emptyMessage}</CommandEmpty>
          {sections.map((section, index) => (
            <CommandGroup
              key={section.id}
              heading={section.heading}
              className={cn(index > 0 && "border-t border-border/50")}
            >
              {section.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  keywords={[item.search]}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                >
                  {item.render()}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    );
  }

  return (
    <LargeVirtualCommand
      sections={sections}
      placeholder={placeholder}
      emptyMessage={emptyMessage}
      className={className}
    />
  );
}

function LargeVirtualCommand({ sections, placeholder, emptyMessage, className }: Required<Omit<VirtualCommandProps, "className">> & Pick<VirtualCommandProps, "className">) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const queryWords = useMemo(
    () => query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const filteredSections = useMemo(
    () =>
      sections
        .map((section) => ({ ...section, items: section.items.filter((item) => matches(item, queryWords)) }))
        .filter((section) => section.items.length > 0),
    [queryWords, sections],
  );

  const { rows, items, itemIndexes, itemRowIndexes } = useMemo(() => {
    const nextRows: VirtualRow[] = [];
    const nextItems: VirtualCommandItem[] = [];
    const nextItemIndexes = new Map<string, number>();
    const nextIndexes = new Map<string, number>();

    filteredSections.forEach((section, sectionIndex) => {
      nextRows.push({ kind: "heading", id: `heading:${section.id}`, heading: section.heading, first: sectionIndex === 0 });
      section.items.forEach((item) => {
        nextIndexes.set(item.id, nextRows.length);
        nextRows.push({ kind: "item", id: `item:${item.id}`, item });
        if (!item.disabled) {
          nextItemIndexes.set(item.id, nextItems.length);
          nextItems.push(item);
        }
      });
    });

    return { rows: nextRows, items: nextItems, itemIndexes: nextItemIndexes, itemRowIndexes: nextIndexes };
  }, [filteredSections]);

  const activeIndex = activeId ? itemIndexes.get(activeId) ?? 0 : 0;
  const activeItem = items[activeIndex];
  const optionId = (id: string) => `${listId}-option-${encodeURIComponent(id)}`;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 8,
  });

  const selectIndex = (index: number) => {
    if (items.length === 0) return;
    const wrapped = (index + items.length) % items.length;
    const item = items[wrapped]!;
    setActiveId(item.id);
    const rowIndex = itemRowIndexes.get(item.id);
    if (rowIndex !== undefined) virtualizer.scrollToIndex(rowIndex, { align: "auto" });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const vimNext = event.ctrlKey && (event.key === "n" || event.key === "j");
    const vimPrevious = event.ctrlKey && (event.key === "p" || event.key === "k");

    if (event.key === "ArrowDown" || vimNext) {
      event.preventDefault();
      selectIndex(activeIndex + 1);
    } else if (event.key === "ArrowUp" || vimPrevious) {
      event.preventDefault();
      selectIndex(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectIndex(items.length - 1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      selectIndex(activeIndex + 10);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      selectIndex(activeIndex - 10);
    } else if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      activeItem.onSelect();
    }
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    setActiveId(undefined);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  return (
    <Command
      shouldFilter={false}
      onKeyDown={handleKeyDown}
      className={cn("bg-transparent p-0", className)}
    >
      <div data-slot="command-input-wrapper" className="p-1 pb-0">
        <InputGroup className="h-8! bg-input/20 dark:bg-input/30">
          <InputGroupInput
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-activedescendant={activeItem ? optionId(activeItem.id) : undefined}
            role="combobox"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className="h-auto w-full text-xs/relaxed outline-hidden"
          />
          <InputGroupAddon>
            <SearchIcon className="size-3.5 shrink-0 opacity-50" />
          </InputGroupAddon>
        </InputGroup>
      </div>
      <div
        ref={scrollRef}
        id={listId}
        role="listbox"
        aria-label="Suggestions"
        tabIndex={-1}
        data-slot="command-list"
        className="no-scrollbar max-h-[420px] scroll-py-1 overflow-x-hidden overflow-y-auto outline-none"
      >
        {rows.length === 0 ? (
          <div role="presentation" className="py-6 text-center text-xs/relaxed">{emptyMessage}</div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              const position = { transform: `translateY(${virtualRow.start}px)` };

              if (row.kind === "heading") {
                return (
                  <div
                    key={row.id}
                    aria-hidden="true"
                    className={cn(
                      "absolute left-0 top-0 flex h-8 w-full items-center px-3 text-xs font-medium text-muted-foreground",
                      !row.first && "border-t border-border/50",
                    )}
                    style={position}
                  >
                    {row.heading}
                  </div>
                );
              }

              return (
                <div
                  key={row.id}
                  id={optionId(row.item.id)}
                  role="option"
                  aria-disabled={row.item.disabled || undefined}
                  aria-selected={row.item.id === activeItem?.id}
                  data-disabled={row.item.disabled || undefined}
                  data-selected={row.item.id === activeItem?.id || undefined}
                  onPointerMove={() => {
                    if (!row.item.disabled) setActiveId(row.item.id);
                  }}
                  onClick={() => {
                    if (!row.item.disabled) row.item.onSelect();
                  }}
                  className="group/command-item absolute left-1 right-1 top-0 flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2.5 text-xs/relaxed outline-hidden data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 data-[selected=true]:*:[svg]:text-foreground"
                  style={position}
                >
                  {row.item.render()}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Command>
  );
}
