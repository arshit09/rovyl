import React from "react";
import {
  Activity, AlarmClock, AlertCircle, AlertTriangle, Anchor, AppWindow, Archive, Armchair,
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, Banknote, BarChart3, Battery, Bell, Bike,
  Binary, Blocks, Bluetooth, Bold, Book, BookOpen, Bookmark, Bot, Box, Boxes, Braces, Briefcase,
  Brush, Bug, Building, Building2, Bus, Cable, Calculator, Calendar, CalendarDays, Camera, Car,
  Cast, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Chrome, Circle,
  Clapperboard, Clipboard, Clock, Cloud, CloudRain, Code, Code2, Codepen, Codesandbox, Coffee,
  Cog, Columns, Command, Compass, Contact, Container, Copy, CornerUpLeft, Cpu, CreditCard, Crop,
  Database, Dices, Disc3, DollarSign, Dot, Download, Dribbble, Droplet, Dumbbell, ExternalLink,
  Eye, EyeOff, Factory, Figma, File as FileGlyph, FileCode, FilePlus, FileSearch, FileStack,
  FileText, Files, Film, Filter, Fingerprint, Flag, Flame, Focus, Folder, FolderKanban,
  FolderOpen, FolderPlus, Frame, Framer, Gamepad, Gamepad2, Ghost, Gift, GitBranch, Github,
  Gitlab, Globe, GraduationCap, Grid2x2, Grid3x3, Hammer, HardDrive, Hash, Headphones, Heart,
  Hexagon, History, Home, Image as ImageGlyph, Import, Info, Instagram, Joystick, Key, Keyboard,
  Landmark, Laptop, Layers, Layers3, LayoutDashboard, LayoutGrid, Leaf, Lightbulb, LineChart,
  Link, Link2, Linkedin, List, ListChecks, ListMusic, ListTodo, Lock, Mail, Map as MapGlyph,
  MapPin, Maximize, Menu, MessageCircle, MessageSquare, Mic, Minimize, Minus,
  Monitor, MonitorPlay, MonitorSmartphone, Moon, MoreHorizontal, MoreVertical, Mountain, Mouse,
  Music, Music2, Navigation, Network, Package, PaintBucket, Palette, PanelLeft, PanelLeftClose,
  Paperclip, Pause, PenLine, Pencil, Percent, Phone, PieChart, Pin, Pizza, Plane, Play, Plug,
  Plus, Podcast, Power, Presentation, Printer, Projector, Puzzle, Radio, Receipt, Redo2,
  RefreshCw, Repeat, Rocket, RotateCcw, Router, Rows, Rss, Satellite, SatelliteDish, Save, Scale,
  Scissors, ScreenShare, Search, SearchCode, Send, Server, Settings, Settings2, Shapes, Share2,
  Shield, ShieldCheck, Ship, ShoppingBag, ShoppingCart, Shuffle, Sigma, SkipBack, SkipForward,
  Slack, Sliders, SlidersHorizontal, Smartphone, Snowflake, Sparkles, Speaker, Square, Star,
  StickyNote, Sun, Sunrise, Sunset, Swords, Table, Tablet, Tag, Target, Tent, Terminal,
  Thermometer, Timer, ToggleLeft, Trash2, TreePine, Trello, TrendingUp, Triangle, Trophy, Truck,
  Tv, Twitch, Twitter, Type, Umbrella, Undo2, Unlock, Upload, Usb, User, UserCircle, Users,
  Utensils, Video, Volume2, Wallet, Wand2, Waves, Webcam, Wifi, Wind, Workflow, Wrench, X,
  Youtube, Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type IconRecord = Record<string, LucideIcon>;

/**
 * Glyphs available synchronously, with no extra chunk.
 *
 * This used to be `import * as icons from "lucide-react"`, which put all ~1,350 icons (~4,000
 * exports once Lucide's aliases are counted) in the very chunk the wheel needs for its first
 * paint. The wheel only ever draws icons the user picked, and those are either bitmaps extracted
 * from the shortcut target or one of the names below; anything else resolves through
 * `loadFullIconMap()`, in a chunk of its own.
 */
export const CURATED_ICON_MAP: IconRecord = Object.assign(Object.create(null) as IconRecord, {
  Activity, AlarmClock, AlertCircle, AlertTriangle, Anchor, AppWindow, Archive, Armchair,
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, Banknote, BarChart3, Battery, Bell, Bike,
  Binary, Blocks, Bluetooth, Bold, Book, BookOpen, Bookmark, Bot, Box, Boxes, Braces, Briefcase,
  Brush, Bug, Building, Building2, Bus, Cable, Calculator, Calendar, CalendarDays, Camera, Car,
  Cast, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Chrome, Circle,
  Clapperboard, Clipboard, Clock, Cloud, CloudRain, Code, Code2, Codepen, Codesandbox, Coffee,
  Cog, Columns, Command, Compass, Contact, Container, Copy, CornerUpLeft, Cpu, CreditCard, Crop,
  Database, Dices, Disc3, DollarSign, Dot, Download, Dribbble, Droplet, Dumbbell, ExternalLink,
  Eye, EyeOff, Factory, Figma, File: FileGlyph, FileCode, FilePlus, FileSearch, FileStack,
  FileText, Files, Film, Filter, Fingerprint, Flag, Flame, Focus, Folder, FolderKanban,
  FolderOpen, FolderPlus, Frame, Framer, Gamepad, Gamepad2, Ghost, Gift, GitBranch, Github,
  Gitlab, Globe, GraduationCap, Grid2x2, Grid3x3, Hammer, HardDrive, Hash, Headphones, Heart,
  Hexagon, History, Home, Image: ImageGlyph, Import, Info, Instagram, Joystick, Key, Keyboard,
  Landmark, Laptop, Layers, Layers3, LayoutDashboard, LayoutGrid, Leaf, Lightbulb, LineChart,
  Link, Link2, Linkedin, List, ListChecks, ListMusic, ListTodo, Lock, Mail, Map: MapGlyph,
  MapPin, Maximize, Menu, MessageCircle, MessageSquare, Mic, Minimize, Minus,
  Monitor, MonitorPlay, MonitorSmartphone, Moon, MoreHorizontal, MoreVertical, Mountain, Mouse,
  Music, Music2, Navigation, Network, Package, PaintBucket, Palette, PanelLeft, PanelLeftClose,
  Paperclip, Pause, PenLine, Pencil, Percent, Phone, PieChart, Pin, Pizza, Plane, Play, Plug,
  Plus, Podcast, Power, Presentation, Printer, Projector, Puzzle, Radio, Receipt, Redo2,
  RefreshCw, Repeat, Rocket, RotateCcw, Router, Rows, Rss, Satellite, SatelliteDish, Save, Scale,
  Scissors, ScreenShare, Search, SearchCode, Send, Server, Settings, Settings2, Shapes, Share2,
  Shield, ShieldCheck, Ship, ShoppingBag, ShoppingCart, Shuffle, Sigma, SkipBack, SkipForward,
  Slack, Sliders, SlidersHorizontal, Smartphone, Snowflake, Sparkles, Speaker, Square, Star,
  StickyNote, Sun, Sunrise, Sunset, Swords, Table, Tablet, Tag, Target, Tent, Terminal,
  Thermometer, Timer, ToggleLeft, Trash2, TreePine, Trello, TrendingUp, Triangle, Trophy, Truck,
  Tv, Twitch, Twitter, Type, Umbrella, Undo2, Unlock, Upload, Usb, User, UserCircle, Users,
  Utensils, Video, Volume2, Wallet, Wand2, Waves, Webcam, Wifi, Wind, Workflow, Wrench, X,
  Youtube, Zap,

  /**
   * Other spellings Lucide ships for glyphs already above. They cost no extra bytes — the same
   * component — and without them a config holding one would fetch the whole set for a glyph that
   * is already here. The `Lucide*` and `*Icon` spellings exist for all 1,353 glyphs, far too many
   * to list; `curatedIcon()` strips those affixes instead.
   */
  CurlyBraces: Braces,
  Edit3: PenLine,
  Grid: Grid3x3,
  Grid2X2: Grid2x2,
  Grid3X3: Grid3x3,
  Sidebar: PanelLeft,
  SidebarClose: PanelLeftClose,
  Stars: Sparkles,
});

/** What gets drawn when a name does not resolve, and while the full set is in flight. */
export const FALLBACK_ICON: LucideIcon = Box;

/**
 * Curated lookup that also accepts Lucide's alias spellings.
 *
 * Lucide exports every glyph three times — `Globe`, `GlobeIcon`, `LucideGlobe` — and the icon
 * picker used to list all three, so a config written by any earlier release can hold any of them.
 * A bare key lookup would miss `LayersIcon`, fetch the whole set on every launch and paint `Box`
 * first, for a glyph that is already in this chunk. Stripping the affix is total and
 * collision-free in 0.292: every one of the 1,353 aliases strips to an existing export that is
 * the identical component, and no canonical name carries either affix.
 */
export function curatedIcon(name: string): LucideIcon | undefined {
  const direct = CURATED_ICON_MAP[name];
  if (direct) return direct;
  if (name.startsWith("Lucide")) return CURATED_ICON_MAP[name.slice(6)];
  if (name.endsWith("Icon")) return CURATED_ICON_MAP[name.slice(0, -4)];
  return undefined;
}

let fullIconMap: IconRecord | null = null;
let fullIconMapPromise: Promise<IconRecord> | null = null;

/** The full set, if it has already loaded. Never starts the load itself. */
export function getLoadedFullIconMap(): IconRecord | null {
  return fullIconMap;
}

/**
 * Loads the remaining ~1,350 glyphs as a separate chunk. Idempotent, and a failure is not
 * remembered, so a later attempt (reopening the picker) can still recover.
 */
export function loadFullIconMap(): Promise<IconRecord> {
  if (fullIconMap) return Promise.resolve(fullIconMap);
  if (!fullIconMapPromise) {
    fullIconMapPromise = import("virtual:lucide-icon-set")
      .then((mod) => {
        fullIconMap = mod as unknown as IconRecord;
        return fullIconMap;
      })
      .catch((err) => {
        fullIconMapPromise = null;
        throw err;
      });
  }
  return fullIconMapPromise;
}

/** Resolve without loading anything: only what is already in memory. */
export function resolveLoadedIcon(name: string | null | undefined): LucideIcon | null {
  if (!name) return null;
  return curatedIcon(name) ?? fullIconMap?.[name] ?? null;
}

/**
 * Warms the full set when — and only when — the config names an icon outside the curated list.
 * Without this the right glyph would arrive a frame after the wheel opens; with it, a config that
 * sticks to curated names never pays for the chunk at all.
 */
export function preloadIconsByName(names: Iterable<string | null | undefined>): void {
  if (fullIconMap || fullIconMapPromise) return;
  for (const name of names) {
    if (name && !curatedIcon(name)) {
      void loadFullIconMap().catch(() => {});
      return;
    }
  }
}

type LazyIconProps = Omit<React.ComponentProps<LucideIcon>, "ref">;

const lazyIconCache = new Map<string, LucideIcon>();

/**
 * A name outside the curated list resolves to a component that requests the full set on mount and
 * redraws itself once it lands. This keeps the `const Icon = getIcon(name)` shape intact at every
 * call site, which is what stops async state leaking into components that only want to draw an
 * icon.
 */
function createLazyIcon(name: string): LucideIcon {
  const LazyIcon = React.forwardRef<SVGSVGElement, LazyIconProps>((props, ref) => {
    const [Resolved, setResolved] = React.useState<LucideIcon | null>(
      () => fullIconMap?.[name] ?? null,
    );

    React.useEffect(() => {
      if (Resolved) return;
      let alive = true;
      loadFullIconMap().then(
        (map) => {
          if (alive) setResolved(() => map[name] ?? FALLBACK_ICON);
        },
        () => {
          if (alive) setResolved(() => FALLBACK_ICON);
        },
      );
      return () => {
        alive = false;
      };
    }, [Resolved]);

    return React.createElement(Resolved ?? FALLBACK_ICON, { ...props, ref });
  });
  LazyIcon.displayName = `LazyLucideIcon(${name})`;
  return LazyIcon as unknown as LucideIcon;
}

export const getIcon = (name: string): LucideIcon => {
  if (!name) return FALLBACK_ICON;
  const curated = curatedIcon(name);
  if (curated) return curated;
  const loaded = fullIconMap?.[name];
  if (loaded) return loaded;

  let lazy = lazyIconCache.get(name);
  if (!lazy) {
    lazy = createLazyIcon(name);
    lazyIconCache.set(name, lazy);
  }
  return lazy;
};

/**
 * Lucide exports every glyph three times (`Globe`, `GlobeIcon`, `LucideGlobe`). Listing the raw
 * keys put 4,059 cells in the picker — each icon repeated three times — and made a search for
 * "icon" return the whole catalogue. Dropping the two affixed spellings leaves 1,353 names, and
 * the affixed ones still resolve in `getIcon`, so configs that already saved one keep working.
 *
 * Not one name per glyph: 35 of them also have a human-readable synonym that survives on purpose
 * (`Train`/`TramFront`, `PanelLeft`/`Sidebar`, `Sparkles`/`Stars`). They are worth the duplicate
 * cell — collapsing by component identity would silently delete the word a user is searching for.
 */
export function listPickableIconNames(map: IconRecord): string[] {
  return Object.keys(map)
    .filter(
      (name) =>
        /^[A-Z]/.test(name) &&
        !name.startsWith("Lucide") &&
        !name.endsWith("Icon") &&
        map[name] != null,
    )
    .sort();
}

/** @deprecated Use `CURATED_ICON_MAP` (sync) or `loadFullIconMap()` (the full set). */
export const ICON_MAP = CURATED_ICON_MAP;
