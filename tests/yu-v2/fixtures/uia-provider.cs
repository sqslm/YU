// tests/yu-v2/fixtures/uia-provider.cs
//
// A synthetic UI Automation *provider* used only by tests. It exposes a fully
// hand-built fragment tree (Window > ToolBar > Edit/ComboBox/Document) through
// IRawElementProviderSimple / IRawElementProviderFragment / IValueProvider and
// answers WM_GETOBJECT with AutomationInteropProvider.ReturnRawElementProvider,
// so nothing depends on Win32/WinForms default accessibility mapping.
//
// The window is created with WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW and shown with
// SW_SHOWNOACTIVATE; no SetForegroundWindow / Activate call exists in this file,
// so creating or refreshing the fixture never takes the foreground.
//
// Protocol: one JSON object per line on stdin, one JSON event per line on
// stdout. stdin is decoded as strict UTF-8 from the raw OS handle (never through
// the PowerShell console encoding), stdout is written as raw UTF-8 bytes.
//
// Compiled by uia-provider.ps1 with csc.exe (C# 5, .NET Framework 4.x).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Provider;

namespace UiaProviderFixture
{
    internal enum Kind
    {
        Window,
        ToolBar,
        Edit,
        ComboBox,
        Document,
        Pane
    }

    internal sealed class Node
    {
        public Kind Kind;
        public string Name = "";
        public string AutomationId = "";
        public string Value; // null => no ValuePattern for this element
        public bool IsPassword;
        public bool IsOffscreen;
        // The getter blocks before answering, so "was the value evaluated at all?"
        // becomes observable instead of a timing guess.
        public bool BlockValueOnRead;
        public bool IsControlElement = true;
        public Node Parent;
        public readonly List<Node> Children = new List<Node>();
        public Rect Bounds;

        public Node(Kind kind)
        {
            Kind = kind;
        }

        public Node Add(Node child)
        {
            child.Parent = this;
            Children.Add(child);
            return child;
        }

        public int ControlTypeId
        {
            get
            {
                switch (Kind)
                {
                    case Kind.Window: return ControlType.Window.Id;
                    case Kind.ToolBar: return ControlType.ToolBar.Id;
                    case Kind.Edit: return ControlType.Edit.Id;
                    case Kind.ComboBox: return ControlType.ComboBox.Id;
                    case Kind.Document: return ControlType.Document.Id;
                    default: return ControlType.Pane.Id;
                }
            }
        }

        public string ControlTypeName
        {
            get
            {
                switch (Kind)
                {
                    case Kind.Window: return "Window";
                    case Kind.ToolBar: return "ToolBar";
                    case Kind.Edit: return "Edit";
                    case Kind.ComboBox: return "ComboBox";
                    case Kind.Document: return "Document";
                    default: return "Pane";
                }
            }
        }
    }

    internal static class Json
    {
        public static string Quote(string value)
        {
            if (value == null) return "null";
            StringBuilder sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Number(int value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        // Flat object of scalars only; the fixture protocol never nests.
        public static Dictionary<string, string> ParseFlat(string text)
        {
            Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.Ordinal);
            int i = Skip(text, 0);
            if (i >= text.Length || text[i] != '{') throw new FormatException("expected '{'");
            i++;
            while (true)
            {
                i = Skip(text, i);
                if (i < text.Length && text[i] == '}')
                {
                    i++;
                    break;
                }
                string key;
                i = ReadString(text, i, out key);
                i = Skip(text, i);
                if (i >= text.Length || text[i] != ':') throw new FormatException("expected ':'");
                i = Skip(text, i + 1);
                string value;
                if (i < text.Length && text[i] == '"')
                {
                    i = ReadString(text, i, out value);
                }
                else
                {
                    int start = i;
                    while (i < text.Length && text[i] != ',' && text[i] != '}') i++;
                    value = text.Substring(start, i - start).Trim();
                    if (value == "null") value = null;
                }
                result[key] = value;
                i = Skip(text, i);
                if (i < text.Length && text[i] == ',')
                {
                    i++;
                    continue;
                }
                if (i < text.Length && text[i] == '}')
                {
                    i++;
                    break;
                }
                throw new FormatException("expected ',' or '}'");
            }
            return result;
        }

        private static int Skip(string text, int i)
        {
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' || text[i] == '\n')) i++;
            return i;
        }

        private static int ReadString(string text, int i, out string value)
        {
            if (i >= text.Length || text[i] != '"') throw new FormatException("expected string");
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < text.Length)
            {
                char c = text[i++];
                if (c == '"')
                {
                    value = sb.ToString();
                    return i;
                }
                if (c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                if (i >= text.Length) throw new FormatException("truncated escape");
                char esc = text[i++];
                switch (esc)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > text.Length) throw new FormatException("truncated \\u escape");
                        sb.Append((char)int.Parse(text.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("bad escape");
                }
            }
            throw new FormatException("unterminated string");
        }
    }

    internal static class Native
    {
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_OVERLAPPEDWINDOW = 0x00CF0000;
        public const int WS_VISIBLE = 0x10000000;
        public const int WS_CAPTION = 0x00C00000;
        public const int WM_DESTROY = 0x0002;
        public const int WM_CLOSE = 0x0010;
        public const int WM_GETOBJECT = 0x003D;
        public const int WM_MOUSEACTIVATE = 0x0021;
        public const int MA_NOACTIVATE = 3;
        public const long UiaRootObjectId = -25;
        public const int SW_SHOWNOACTIVATE = 4;
        public const uint WM_APP_DESTROY = 0x8000 + 1;
        public const uint SMTO_ABORTIFHUNG = 0x0002;
        public static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct WNDCLASSEX
        {
            public int cbSize;
            public int style;
            public IntPtr lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            public string lpszMenuName;
            public string lpszClassName;
            public IntPtr hIconSm;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd;
            public int message;
            public IntPtr wParam;
            public IntPtr lParam;
            public int time;
            public POINT pt;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        public delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandleW(string name);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern ushort RegisterClassExW(ref WNDCLASSEX wc);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateWindowExW(
            int exStyle, string className, string windowName, int style,
            int x, int y, int width, int height,
            IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint size);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hwnd, int command);

        // Required for a provider returned from WM_GETOBJECT: the UIA core refuses
        // (UiaReturnRawElementProvider yields E_FAIL) any root provider whose
        // HostRawElementProvider is null.
        [DllImport("UIAutomationCore.dll")]
        public static extern int UiaHostProviderFromHwnd(
            IntPtr hwnd, [MarshalAs(UnmanagedType.Interface)] out IRawElementProviderSimple provider);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool SetWindowTextW(IntPtr hwnd, string text);

        [DllImport("user32.dll")]
        public static extern bool DestroyWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);

        [DllImport("user32.dll")]
        public static extern bool TranslateMessage(ref MSG msg);

        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessageW(ref MSG msg);

        [DllImport("user32.dll")]
        public static extern void PostQuitMessage(int code);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostThreadMessageW(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeoutW(
            IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    }

    internal sealed class Fixture
    {
        // Escaped so the box name survives any source encoding: 地址和搜索栏.
        private const string AddressNameLiteral = "\u5730\u5740\u548C\u641C\u7D22\u680F";

        public static Fixture Current;

        private static readonly object OutLock = new object();
        private static StreamWriter stdout;

        private readonly Dictionary<Node, Provider> providers = new Dictionary<Node, Provider>();
        private readonly ManualResetEventSlim blockGate = new ManualResetEventSlim(true);
        private readonly ManualResetEventSlim valueGate = new ManualResetEventSlim(false);
        private readonly object stateLock = new object();

        private volatile bool blocking;
        private int blockSignalled;
        private int shutdownRequested;
        private int stdinClosed;

        // Failure injection for the "real UIA failure must propagate" contract.
        [Flags]
        public enum FailStage
        {
            None = 0,
            GetProperty = 1,
            FindChildren = 2,
            RootFragment = 4,
            HostHwnd = 8,
            // Never released: every non-root provider read stalls until the caller
            // gives up, which is the one provider fault a UIA client cannot miss.
            Unresponsive = 16,
            Both = GetProperty | FindChildren | RootFragment | HostHwnd
        }

        public readonly string Mode;
        public readonly FailStage Failure;
        public string FilePath;
        public IntPtr DummyHostHwnd = IntPtr.Zero;
        private int tempFileDeleted;
        public Node Root;
        public IntPtr Window = IntPtr.Zero;
        public IntPtr Control = IntPtr.Zero;
        public string Title;
        public readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        public uint WindowThreadId;
        public volatile bool WindowAlive;

        public Fixture(string mode, FailStage failure)
        {
            Mode = mode;
            Failure = failure;
            Title = "UIA fixture - " + mode + (failure == FailStage.None ? "" : " [" + FailureName(failure) + "]");
        }

        public bool Fails(FailStage stage)
        {
            return (Failure & stage) == stage;
        }

        private readonly HashSet<string> injections = new HashSet<string>();

        // One event per call site, so a driver can prove the exception really happened
        // even when the UIA core swallows it before the client notices.
        public void NoteInjection(string call)
        {
            lock (injections)
            {
                if (!injections.Add(call)) return;
            }
            WriteEvent("{\"type\":\"injected\",\"stage\":" + Json.Quote(FailureName(Failure)) +
                       ",\"call\":" + Json.Quote(call) + "}");
        }

        public static string FailureName(FailStage stage)
        {
            switch (stage)
            {
                case FailStage.None: return "none";
                case FailStage.GetProperty: return "get-property";
                case FailStage.FindChildren: return "find-children";
                case FailStage.RootFragment: return "root-fragment";
                case FailStage.HostHwnd: return "host-hwnd";
                case FailStage.Unresponsive: return "unresponsive";
                case FailStage.Both: return "both";
                default: return stage.ToString().ToLowerInvariant();
            }
        }

        public static FailStage ParseFailStage(string value)
        {
            if (string.IsNullOrEmpty(value)) return FailStage.None;
            switch (value.Trim().ToLowerInvariant())
            {
                case "none": return FailStage.None;
                case "get-property": return FailStage.GetProperty;
                case "find-children": return FailStage.FindChildren;
                case "root-fragment": return FailStage.RootFragment;
                case "host-hwnd": return FailStage.HostHwnd;
                case "unresponsive": return FailStage.Unresponsive;
                case "both": return FailStage.Both;
                default:
                    throw new ArgumentException("unknown -FailStage '" + value +
                                                "'; expected get-property, find-children or both");
            }
        }

        // file-url mode: the fixture owns the file, so no caller can point the tested
        // path at a user document.
        private static string CreateTempFile()
        {
            // Non-ASCII, space and a literal percent sign: the file:// URI has to carry
            // the same escaping a real browser produces, so the name must exercise it.
            string path = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
                "yu-uia-中文 100% " + Guid.NewGuid().ToString("N") + ".md");
            System.IO.File.WriteAllText(path, "# uia fixture file url" + Environment.NewLine, new UTF8Encoding(false));
            return LongPath(path);
        }

        private static string LongPath(string path)
        {
            StringBuilder buffer = new StringBuilder(1024);
            uint length = Native.GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
            return length > 0 && length < buffer.Capacity ? buffer.ToString() : path;
        }

        public void DeleteTempFile()
        {
            if (FilePath == null) return;
            if (Interlocked.Exchange(ref tempFileDeleted, 1) == 1) return;
            try { System.IO.File.Delete(FilePath); }
            catch (Exception error)
            {
                // Teardown never throws; a failed cleanup is reported on stderr only.
                try { Console.Error.WriteLine("fixture: temp file cleanup failed: " + error.Message); }
                catch { }
            }
        }

        public static void OpenStdout()
        {
            lock (OutLock)
            {
                if (stdout != null) return;
                stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 8192);
                stdout.AutoFlush = false;
            }
        }

        public static void WriteEvent(string json)
        {
            lock (OutLock)
            {
                if (stdout == null) return;
                stdout.Write(json);
                stdout.Write('\n');
                stdout.Flush();
            }
        }

        public string HandleText
        {
            get
            {
                IntPtr handle = Window;
                return "0x" + handle.ToInt64().ToString("X", CultureInfo.InvariantCulture);
            }
        }

        // ---------- tree ----------

        private static Node NewNode(Kind kind, string name, string id, string value)
        {
            Node node = new Node(kind);
            node.Name = name ?? "";
            node.AutomationId = id ?? "";
            node.Value = value;
            return node;
        }

        private static Node ToolBar(Node parent, string name, string id)
        {
            return parent.Add(NewNode(Kind.ToolBar, name, id, null));
        }

        private static Node AddressEdit(Node parent, string id, string name, string value)
        {
            return parent.Add(NewNode(Kind.Edit, name, id, value));
        }

        private static Node Document(Node parent, string name, string value)
        {
            return parent.Add(NewNode(Kind.Document, name, "document", value));
        }

        private Node BuildTree()
        {
            Node root = NewNode(Kind.Window, Title, "fixtureRoot", null);
            Node toolbar;
            Node edit;
            int i;

            switch (Mode)
            {
                case "address-edit":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/a");
                    break;

                case "file-url":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar",
                        new Uri(FilePath).AbsoluteUri);
                    break;

                case "excluded-value-blocked":
                {
                    // pseudo-address shape, but the excluded field blocks on read: a reader
                    // that evaluates excluded candidates anyway will stall or touch it.
                    Node blockedDoc = Document(root, "evil page", "evil page");
                    Node blockedToolbar = ToolBar(blockedDoc, "Page toolbar", "pageToolbar");
                    AddressEdit(blockedToolbar, "", AddressNameLiteral,
                        "https://example.com/pseudo").BlockValueOnRead = true;
                    break;
                }

                case "no-value-pattern":
                    // A candidate with a real chrome ancestry but no ValuePattern at all:
                    // GetPatternProvider returns null, so there is no address to read.
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", null);
                    break;

                case "metadata-document":
                    // One Document, no address bar: metadataOnly=true must not read its value.
                    Document(root, "page", "https://example.com/doc");
                    break;

                case "metadata-override":
                    // Both sources present: the Document still overrides the address bar.
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar",
                        "https://example.com/from-bar");
                    Document(root, "page", "https://example.com/from-doc");
                    break;

                case "provider-error":
                    // Same shape as address-edit so both readers can be compared directly;
                    // the injected failure happens in the provider callbacks.
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/a");
                    break;

                case "address-combo":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    toolbar.Add(NewNode(Kind.ComboBox, AddressNameLiteral, "", "https://example.com/b"));
                    break;

                case "no-candidate":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    toolbar.Add(NewNode(Kind.Pane, "Bookmarks", "bookmarkStrip", null));
                    break;

                case "duplicate":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/c");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/c");
                    break;

                case "ambiguous":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/d");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/e");
                    break;

                case "document-overrides":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/f");
                    Document(root, "Page", "https://example.com/g");
                    break;

                case "document-ambiguous":
                    Document(root, "Page A", "https://example.com/x");
                    Document(root, "Page B", "https://example.com/y");
                    break;

                case "pseudo-address":
                    // A page-level Document containing its own toolbar and a field
                    // that names itself like the address bar. The ancestor walk
                    // must stop at the Document, so this is never browser chrome.
                    Node doc = Document(root, "evil page", "evil page");
                    Node innerToolbar = ToolBar(doc, "Page toolbar", "pageToolbar");
                    AddressEdit(innerToolbar, "", AddressNameLiteral, "https://evil.example/x");
                    break;

                case "password":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    edit = AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/h");
                    edit.IsPassword = true;
                    break;

                case "offscreen":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    edit = AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/i");
                    edit.IsOffscreen = true;
                    break;

                case "no-toolbar":
                    AddressEdit(root, "addressEditBox", "Address and search bar", "https://example.com/j");
                    break;

                case "deep-40":
                    // Edit sits 40 levels below the window: iteration 40 of the
                    // production walk lands exactly on the root.
                    BuildDeepChain(root, 40, "https://example.com/deep-40");
                    break;

                case "deep-41":
                    BuildDeepChain(root, 41, "https://example.com/deep-41");
                    break;

                case "documents-20":
                    for (i = 0; i < 20; i++) Document(root, "Page " + i, "https://example.com/doc");
                    break;

                case "documents-21":
                    // 20 identical URLs inside the cap plus one different URL past it.
                    for (i = 0; i < 20; i++) Document(root, "Page " + i, "https://example.com/doc");
                    Document(root, "Page late", "https://example.com/late");
                    break;

                case "edits-100":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    for (i = 0; i < 100; i++)
                        AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/edit");
                    break;

                case "edits-101":
                    toolbar = ToolBar(root, "Browser chrome", "browserToolbar");
                    for (i = 0; i < 100; i++)
                        AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/edit");
                    AddressEdit(toolbar, "addressEditBox", "Address and search bar", "https://example.com/late");
                    break;

                default:
                    throw new ArgumentException("unknown mode: " + Mode);
            }

            return root;
        }

        // edit at `depth` levels below root, toolbar immediately above it
        private static void BuildDeepChain(Node root, int depth, string value)
        {
            Node parent = root;
            for (int level = 1; level <= depth - 2; level++)
                parent = parent.Add(NewNode(Kind.Pane, "Level " + level, "level" + level, null));
            Node toolbar = ToolBar(parent, "Browser chrome", "browserToolbar");
            AddressEdit(toolbar, "addressEditBox", "Address and search bar", value);
        }

        public static readonly string[] Modes =
        {
            "address-edit", "address-combo", "no-candidate", "duplicate", "ambiguous",
            "document-overrides", "document-ambiguous", "pseudo-address", "password",
            "offscreen", "no-toolbar", "deep-40", "deep-41", "documents-20",
            "documents-21", "edits-100", "edits-101", "provider-error", "file-url",
            "excluded-value-blocked", "no-value-pattern", "metadata-document", "metadata-override"
        };

        public static bool IsMode(string mode)
        {
            return Array.IndexOf(Modes, mode) >= 0;
        }

        // ---------- bounds ----------

        private void AssignBounds(Node node, ref int line)
        {
            node.Bounds = new Rect(8, 8 + (line % 600) * 18, 360, 16);
            line++;
            for (int i = 0; i < node.Children.Count; i++) AssignBounds(node.Children[i], ref line);
        }

        // ---------- providers ----------

        public Provider RootProvider
        {
            get { return ProviderFor(Root); }
        }

        public Provider ProviderFor(Node node)
        {
            Node owner = node;
            lock (providers)
            {
                Provider provider;
                if (!providers.TryGetValue(owner, out provider))
                {
                    provider = new Provider(this, owner, owner.GetHashCode() ^ (int)(uint)owner.ControlTypeId);
                    providers[owner] = provider;
                }
                return provider;
            }
        }

        public IRawElementProviderFragment HitTest(double x, double y)
        {
            Node found = HitTestNode(Root, x, y);
            return found == null ? null : (IRawElementProviderFragment)ProviderFor(found);
        }

        private static Node HitTestNode(Node node, double x, double y)
        {
            for (int i = 0; i < node.Children.Count; i++)
            {
                Node child = HitTestNode(node.Children[i], x, y);
                if (child != null) return child;
            }
            if (node.Bounds.Width > 0 && node.Bounds.Height > 0 &&
                x >= node.Bounds.X && x <= node.Bounds.X + node.Bounds.Width &&
                y >= node.Bounds.Y && y <= node.Bounds.Y + node.Bounds.Height)
                return node;
            return null;
        }

        // ---------- block gate ----------

        // Unconditional: emitted for every Value getter call, never for pattern
        // lookups, so a reader that inspects structure without reading a value
        // stays distinguishable from one that does.
        public void NoteValueRead(Node node)
        {
            WriteEvent("{\"type\":\"value-read\",\"id\":" + Json.Quote(node.AutomationId) +
                       ",\"name\":" + Json.Quote(node.Name) +
                       ",\"controlType\":" + Json.Quote(node.ControlTypeName) + "}");
        }

        public void WaitValueBlocked()
        {
            // Bounded: a forgotten unblock can never wedge the fixture.
            valueGate.Wait(2000);
        }

        public void NoteProviderCall(Node node)
        {
            if (!blocking || node == Root) return;
            if (Interlocked.Exchange(ref blockSignalled, 1) == 0)
            {
                WriteEvent("{\"type\":\"blocked\",\"mode\":" + Json.Quote(Mode) +
                           ",\"controlType\":" + Json.Quote(node.ControlTypeName) + "}");
            }
            // Bounded so a forgotten unblock can never wedge the process forever.
            blockGate.Wait(120000);
        }

        private void SetBlocking(bool value)
        {
            if (value)
            {
                blockGate.Reset();
                valueGate.Reset();
                Interlocked.Exchange(ref blockSignalled, 0);
                blocking = true;
            }
            else
            {
                blocking = false;
                blockGate.Set();
                valueGate.Set();
            }
        }

        // ---------- window ----------

        private static Native.WndProcDelegate windowProc; // keep the delegate alive

        private static IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            Fixture fixture = Current;
            try
            {
                if (msg == Native.WM_GETOBJECT && lParam.ToInt64() == Native.UiaRootObjectId)
                {
                    if (fixture != null && fixture.WindowAlive && hwnd == fixture.Window)
                        return AutomationInteropProvider.ReturnRawElementProvider(
                            hwnd, wParam, lParam, fixture.RootProvider);
                    return IntPtr.Zero;
                }
                if (msg == Native.WM_MOUSEACTIVATE && fixture != null && hwnd == fixture.Window)
                    return new IntPtr(Native.MA_NOACTIVATE);
                if (msg == Native.WM_APP_DESTROY && fixture != null && hwnd == fixture.Window)
                {
                    fixture.WindowAlive = false;
                    fixture.DeleteTempFile();
                    Native.DestroyWindow(hwnd);
                    return IntPtr.Zero;
                }
                if (msg == Native.WM_CLOSE && fixture != null && hwnd == fixture.Window)
                {
                    fixture.WindowAlive = false;
                    fixture.DeleteTempFile();
                    Native.DestroyWindow(hwnd);
                    return IntPtr.Zero;
                }
                if (msg == Native.WM_DESTROY && fixture != null)
                {
                    if (hwnd == fixture.Window)
                    {
                        fixture.WindowAlive = false;
                        fixture.Window = IntPtr.Zero;
                    }
                    return IntPtr.Zero;
                }
            }
            catch (Exception error)
            {
                WriteEvent("{\"type\":\"error\",\"stage\":\"wndproc\",\"message\":" + Json.Quote(error.Message) + "}");
            }
            return Native.DefWindowProcW(hwnd, msg, wParam, lParam);
        }

        private void RegisterClass(string name)
        {
            if (windowProc == null) windowProc = WndProc;
            Native.WNDCLASSEX wc = new Native.WNDCLASSEX();
            wc.cbSize = Marshal.SizeOf(typeof(Native.WNDCLASSEX));
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(windowProc);
            wc.hInstance = Native.GetModuleHandleW(null);
            wc.lpszClassName = name;
            ushort atom = Native.RegisterClassExW(ref wc);
            if (atom == 0)
            {
                int code = Marshal.GetLastWin32Error();
                // 1410 = class already registered in this process; harmless.
                if (code != 1410) throw new InvalidOperationException("RegisterClassExW failed: " + code);
            }
        }

        public void CreateWindows()
        {
            if (Mode == "file-url") FilePath = CreateTempFile();
            OpenStdout();
            Root = BuildTree();
            int line = 0;
            AssignBounds(Root, ref line);

            RegisterClass("UiaFixtureWindow");
            RegisterClass("UiaFixtureControl");

            // Message-only control window so commands reach the pump even after
            // the visible window is destroyed.
            Control = Native.CreateWindowExW(0, "UiaFixtureControl", "uia-fixture-control", 0,
                0, 0, 0, 0, Native.HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (Control == IntPtr.Zero)
                throw new InvalidOperationException("control window creation failed: " + Marshal.GetLastWin32Error());

            // A destroyed secondary window: host-hwnd failure mode points the root's
            // HostRawElementProvider at it while the fixture window itself stays alive.
            DummyHostHwnd = Native.CreateWindowExW(0, "UiaFixtureControl", "uia-fixture-dummy", 0,
                0, 0, 0, 0, Native.HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (DummyHostHwnd != IntPtr.Zero) Native.DestroyWindow(DummyHostHwnd);

            WindowThreadId = Native.GetCurrentThreadId();
            // Shown without activation: WS_EX_NOACTIVATE + SW_SHOWNOACTIVATE.
            Window = Native.CreateWindowExW(
                Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW,
                "UiaFixtureWindow", Title,
                Native.WS_OVERLAPPEDWINDOW | Native.WS_VISIBLE,
                80, 80, 520, 320,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (Window == IntPtr.Zero)
                throw new InvalidOperationException("window creation failed: " + Marshal.GetLastWin32Error());

            WindowAlive = true;
            Native.ShowWindow(Window, Native.SW_SHOWNOACTIVATE);

            Native.RECT rect;
            if (Native.GetWindowRect(Window, out rect))
                Root.Bounds = new Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);

            if (Failure == FailStage.Unresponsive) SetBlocking(true);

            WriteEvent("{\"type\":\"ready\",\"pid\":" + Json.Number(Pid) +
                       ",\"handle\":" + Json.Quote(HandleText) +
                       ",\"title\":" + Json.Quote(Title) +
                       ",\"mode\":" + Json.Quote(Mode) +
                       (FilePath == null ? "" : ",\"file\":" + Json.Quote(FilePath)) + "}");
        }

        // ---------- commands ----------

        public void HandleCommand(string line)
        {
            Dictionary<string, string> command;
            try
            {
                command = Json.ParseFlat(line);
            }
            catch (Exception error)
            {
                WriteEvent("{\"type\":\"error\",\"stage\":\"parse\",\"message\":" + Json.Quote(error.Message) +
                           ",\"line\":" + Json.Quote(line) + "}");
                return;
            }

            string name;
            if (!command.TryGetValue("command", out name) || string.IsNullOrEmpty(name))
            {
                WriteEvent("{\"type\":\"error\",\"message\":\"missing command\"}");
                return;
            }

            switch (name)
            {
                case "describe":
                    WriteEvent(DescribeJson());
                    break;

                case "retitle":
                {
                    string title;
                    if (!command.TryGetValue("title", out title) || title == null)
                    {
                        WriteEvent("{\"type\":\"error\",\"message\":\"retitle needs a title\"}");
                        return;
                    }
                    Title = title;
                    Root.Name = title;
                    lock (stateLock)
                    {
                        if (WindowAlive && Window != IntPtr.Zero) Native.SetWindowTextW(Window, title);
                    }
                    WriteEvent("{\"type\":\"title\",\"title\":" + Json.Quote(Title) +
                               ",\"handle\":" + Json.Quote(HandleText) + "}");
                    break;
                }

                case "block":
                    SetBlocking(true);
                    WriteEvent("{\"type\":\"blocking\"}");
                    break;

                case "unblock":
                    SetBlocking(false);
                    WriteEvent("{\"type\":\"unblocked\"}");
                    break;

                case "destroy":
                {
                    IntPtr target = Window;
                    if (!WindowAlive || target == IntPtr.Zero)
                    {
                        WriteEvent("{\"type\":\"destroyed\",\"already\":true,\"handle\":\"0x0\"}");
                        return;
                    }
                    IntPtr ignored;
                    Native.SendMessageTimeoutW(target, Native.WM_APP_DESTROY, IntPtr.Zero, IntPtr.Zero,
                        Native.SMTO_ABORTIFHUNG, 2000, out ignored);
                    WriteEvent("{\"type\":\"destroyed\",\"already\":false,\"handle\":\"0x0\"}");
                    break;
                }

                case "quit":
                    WriteEvent("{\"type\":\"quit\",\"handle\":" + Json.Quote(HandleText) + "}");
                    Shutdown();
                    break;

                default:
                    WriteEvent("{\"type\":\"error\",\"message\":" + Json.Quote("unknown command: " + name) + "}");
                    break;
            }
        }

        private string DescribeJson()
        {
            bool alive = WindowAlive;
            return "{\"type\":\"describe\",\"pid\":" + Json.Number(Pid) +
                   ",\"handle\":" + Json.Quote(alive ? HandleText : "0x0") +
                   ",\"title\":" + Json.Quote(Title) +
                   ",\"mode\":" + Json.Quote(Mode) +
                   ",\"failStage\":" + Json.Quote(FailureName(Failure)) +
                   (FilePath == null ? "" : ",\"file\":" + Json.Quote(FilePath)) +
                   ",\"alive\":" + (alive ? "true" : "false") +
                   ",\"blocking\":" + (blocking ? "true" : "false") +
                   ",\"rootName\":" + Json.Quote(Root == null ? null : Root.Name) + "}";
        }

        public void Shutdown()
        {
            if (Interlocked.Exchange(ref shutdownRequested, 1) == 1) return;
            SetBlocking(false);
            if (WindowAlive && Window != IntPtr.Zero)
            {
                IntPtr ignored;
                Native.SendMessageTimeoutW(Window, Native.WM_APP_DESTROY, IntPtr.Zero, IntPtr.Zero,
                    Native.SMTO_ABORTIFHUNG, 2000, out ignored);
            }
            DeleteTempFile();
            Native.PostThreadMessageW(WindowThreadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
        }

        public void RunStdinLoop()
        {
            Thread thread = new Thread(StdinLoop);
            thread.IsBackground = true;
            thread.Name = "uia-fixture-stdin";
            thread.Start();
        }

        private void StdinLoop()
        {
            // Raw UTF-8 from the OS handle: never the PowerShell console encoding.
            StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 8192);
            try
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (line.Length == 0) continue;
                    HandleCommand(line);
                }
            }
            catch (Exception error)
            {
                WriteEvent("{\"type\":\"error\",\"stage\":\"stdin\",\"message\":" + Json.Quote(error.Message) + "}");
            }
            finally
            {
                Interlocked.Exchange(ref stdinClosed, 1);
                // stdin closed == the driver is gone; never leave an orphan process.
                Shutdown();
            }
        }

        public void PumpMessages()
        {
            Native.MSG msg;
            while (true)
            {
                int code = Native.GetMessageW(out msg, IntPtr.Zero, 0, 0);
                if (code <= 0) break;
                Native.TranslateMessage(ref msg);
                Native.DispatchMessageW(ref msg);
            }
            if (Control != IntPtr.Zero && Native.IsWindow(Control)) Native.DestroyWindow(Control);
            lock (OutLock)
            {
                if (stdout != null) stdout.Flush();
            }
        }
    }

    internal sealed class Provider :
        IRawElementProviderSimple,
        IRawElementProviderFragment,
        IRawElementProviderFragmentRoot,
        IValueProvider
    {
        private static readonly int ControlTypeProperty = AutomationElementIdentifiers.ControlTypeProperty.Id;
        private static readonly int NameProperty = AutomationElementIdentifiers.NameProperty.Id;
        private static readonly int AutomationIdProperty = AutomationElementIdentifiers.AutomationIdProperty.Id;
        private static readonly int IsPasswordProperty = AutomationElementIdentifiers.IsPasswordProperty.Id;
        private static readonly int IsOffscreenProperty = AutomationElementIdentifiers.IsOffscreenProperty.Id;
        private static readonly int IsEnabledProperty = AutomationElementIdentifiers.IsEnabledProperty.Id;
        private static readonly int IsControlElementProperty = AutomationElementIdentifiers.IsControlElementProperty.Id;
        private static readonly int IsContentElementProperty = AutomationElementIdentifiers.IsContentElementProperty.Id;
        private static readonly int BoundingRectangleProperty = AutomationElementIdentifiers.BoundingRectangleProperty.Id;
        private static readonly int ProcessIdProperty = AutomationElementIdentifiers.ProcessIdProperty.Id;
        private static readonly int ClassNameProperty = AutomationElementIdentifiers.ClassNameProperty.Id;
        private static readonly int HelpTextProperty = AutomationElementIdentifiers.HelpTextProperty.Id;
        private static readonly int LocalizedControlTypeProperty = AutomationElementIdentifiers.LocalizedControlTypeProperty.Id;
        private static readonly int FrameworkIdProperty = AutomationElementIdentifiers.FrameworkIdProperty.Id;
        private static readonly int IsKeyboardFocusableProperty = AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id;
        private static readonly int HasKeyboardFocusProperty = AutomationElementIdentifiers.HasKeyboardFocusProperty.Id;

        private readonly Fixture fixture;
        private readonly Node node;
        private readonly int runtimeId;

        public Provider(Fixture fixture, Node node, int runtimeId)
        {
            this.fixture = fixture;
            this.node = node;
            this.runtimeId = runtimeId & 0x3FFFFFFF;
        }

        public Node Node
        {
            get { return node; }
        }

        // ---------- IRawElementProviderSimple ----------

        ProviderOptions IRawElementProviderSimple.ProviderOptions
        {
            get { return ProviderOptions.ServerSideProvider; }
        }

        IRawElementProviderSimple IRawElementProviderSimple.HostRawElementProvider
        {
            get
            {
                // Only the node that owns the HWND is hosted; fragments report null.
                if (node != fixture.Root) return null;
                IntPtr window = fixture.Window;
                if (window == IntPtr.Zero) return null;
                IRawElementProviderSimple host;
                return Native.UiaHostProviderFromHwnd(window, out host) == 0 ? host : null;
            }
        }

        object IRawElementProviderSimple.GetPropertyValue(int propertyId)
        {
            fixture.NoteProviderCall(node);
            if (fixture.Fails(Fixture.FailStage.RootFragment) && node == fixture.Root)
            {
                fixture.NoteInjection(node == fixture.Root ? "root:GetPropertyValue" : "GetPropertyValue");
                throw new InvalidOperationException(
                    "injected root-fragment failure: GetPropertyValue(" + propertyId + ")");
            }
            if (fixture.Fails(Fixture.FailStage.GetProperty) && node.Kind == Kind.Edit &&
                propertyId == ControlTypeProperty)
            {
                fixture.NoteInjection("GetPropertyValue(ControlType)");
                throw new InvalidOperationException(
                    "injected get-property failure: ControlType for " + node.AutomationId);
            }
            if (propertyId == ControlTypeProperty) return node.ControlTypeId;
            if (propertyId == NameProperty) return node.Name;
            if (propertyId == AutomationIdProperty) return node.AutomationId;
            if (propertyId == IsPasswordProperty) return node.IsPassword;
            if (propertyId == IsOffscreenProperty) return node.IsOffscreen;
            if (propertyId == IsEnabledProperty) return true;
            if (propertyId == IsControlElementProperty) return node.IsControlElement;
            if (propertyId == IsContentElementProperty) return node.IsControlElement;
            if (propertyId == BoundingRectangleProperty) return node.Bounds;
            if (propertyId == ProcessIdProperty) return fixture.Pid;
            if (propertyId == ClassNameProperty) return "UiaFixtureNode";
            if (propertyId == HelpTextProperty) return "";
            if (propertyId == LocalizedControlTypeProperty) return node.ControlTypeName;
            if (propertyId == FrameworkIdProperty) return "UiaFixture";
            if (propertyId == IsKeyboardFocusableProperty) return false;
            if (propertyId == HasKeyboardFocusProperty) return false;
            return null;
        }

        object IRawElementProviderSimple.GetPatternProvider(int patternId)
        {
            if (fixture.Fails(Fixture.FailStage.RootFragment) && node == fixture.Root)
            {
                fixture.NoteInjection("root:GetPatternProvider");
                throw new InvalidOperationException("injected root-fragment failure: GetPatternProvider");
            }
            fixture.NoteProviderCall(node);
            if (patternId == ValuePattern.Pattern.Id && node.Value != null) return this;
            return null;
        }

        // ---------- IRawElementProviderFragment ----------

        int[] IRawElementProviderFragment.GetRuntimeId()
        {
            if (fixture.Fails(Fixture.FailStage.RootFragment) && node == fixture.Root)
            {
                fixture.NoteInjection("root:GetRuntimeId");
                throw new InvalidOperationException("injected root-fragment failure: GetRuntimeId");
            }
            return new int[] { AutomationInteropProvider.AppendRuntimeId, runtimeId };
        }

        Rect IRawElementProviderFragment.BoundingRectangle
        {
            get { return node.Bounds; }
        }

        IRawElementProviderFragmentRoot IRawElementProviderFragment.FragmentRoot
        {
            get { return node == fixture.Root ? null : fixture.RootProvider; }
        }

        IRawElementProviderFragment IRawElementProviderFragment.Navigate(NavigateDirection direction)
        {
            if (fixture.Fails(Fixture.FailStage.RootFragment) && node == fixture.Root)
            {
                fixture.NoteInjection("root:Navigate");
                throw new InvalidOperationException("injected root-fragment failure: Navigate");
            }
            Node parent = node.Parent;
            switch (direction)
            {
                case NavigateDirection.Parent:
                    return parent == null ? null : fixture.ProviderFor(parent);

                case NavigateDirection.FirstChild:
                    if (fixture.Fails(Fixture.FailStage.FindChildren) &&
                        (node.Kind == Kind.ToolBar || node.Kind == Kind.Document))
                    {
                        fixture.NoteInjection("Navigate(FirstChild)");
                        throw new InvalidOperationException(
                            "injected find-children failure: FirstChild of " + node.AutomationId);
                    }
                    return node.Children.Count == 0 ? null : fixture.ProviderFor(node.Children[0]);

                case NavigateDirection.LastChild:
                    return node.Children.Count == 0 ? null : fixture.ProviderFor(node.Children[node.Children.Count - 1]);

                case NavigateDirection.NextSibling:
                {
                    if (parent == null) return null;
                    int index = parent.Children.IndexOf(node);
                    if (index < 0 || index + 1 >= parent.Children.Count) return null;
                    return fixture.ProviderFor(parent.Children[index + 1]);
                }

                case NavigateDirection.PreviousSibling:
                {
                    if (parent == null) return null;
                    int index = parent.Children.IndexOf(node);
                    if (index <= 0) return null;
                    return fixture.ProviderFor(parent.Children[index - 1]);
                }
            }
            return null;
        }

        IRawElementProviderSimple[] IRawElementProviderFragment.GetEmbeddedFragmentRoots()
        {
            return null;
        }

        void IRawElementProviderFragment.SetFocus()
        {
            // Never moves focus: the fixture must not take the foreground.
        }

        // ---------- IRawElementProviderFragmentRoot ----------

        IRawElementProviderFragment IRawElementProviderFragmentRoot.ElementProviderFromPoint(double x, double y)
        {
            return fixture.HitTest(x, y);
        }

        IRawElementProviderFragment IRawElementProviderFragmentRoot.GetFocus()
        {
            return null;
        }

        // ---------- IValueProvider ----------

        bool IValueProvider.IsReadOnly
        {
            get { return false; }
        }

        string IValueProvider.Value
        {
            get
            {
                fixture.NoteProviderCall(node);
                fixture.NoteValueRead(node);
                if (node.BlockValueOnRead)
                {
                    Fixture.WriteEvent("{\"type\":\"value-blocked\",\"id\":" +
                                       Json.Quote(node.AutomationId) + "}");
                    fixture.WaitValueBlocked();
                }
                return node.Value ?? "";
            }
        }

        void IValueProvider.SetValue(string value)
        {
            node.Value = value;
            Fixture.WriteEvent("{\"type\":\"set-value\",\"controlType\":" + Json.Quote(node.ControlTypeName) +
                               ",\"value\":" + Json.Quote(value) + "}");
        }
    }

    public static class Program
    {
        public static string[] SupportedModes()
        {
            return Fixture.Modes;
        }

        public static int Run(string mode, string failStage)
        {
            if (!Fixture.IsMode(mode))
                throw new ArgumentException("unknown mode '" + mode + "'; expected one of: " +
                                            string.Join(", ", Fixture.Modes));

            Fixture fixture = new Fixture(mode, Fixture.ParseFailStage(failStage));
            Fixture.Current = fixture;
            fixture.CreateWindows();
            fixture.RunStdinLoop();
            fixture.PumpMessages();
            return 0;
        }
    }
}
