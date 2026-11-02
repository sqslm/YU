# Disposable UIA fixture. All content is synthetic; stdin selects a mode.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition @'
using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class YuUiaFixture {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint thread, uint foreground, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static Form form;
  class FixtureEditor : TextBox {
    public bool BlockProvider;
    protected override void OnKeyPress(KeyPressEventArgs e) { e.Handled = true; }
    protected override void WndProc(ref Message message) {
      if (BlockProvider && (message.Msg == 0x003d || message.Msg == 0x000d || message.Msg == 0x000e)) Thread.Sleep(10000);
      base.WndProc(ref message);
    }
  }
  static FixtureEditor editor;
  static FixtureEditor password;
  static Button button;
  static JavaScriptSerializer json = new JavaScriptSerializer();
  static void Mode(string mode) {
    if (mode == "quit") { form.Close(); return; }
    editor.BlockProvider = false;
    editor.Visible = mode != "button" && mode != "password";
    password.Visible = mode == "password";
    button.Visible = mode == "button";
    editor.ReadOnly = mode == "readonly";
    string value = mode == "long" ? new string('\u4e2d', 4090) + "\ud83d\ude00END" : "UIA fixture: \u4e2d\u6587 hello \ud83d\ude00";
    editor.Text = value;
    password.Text = value;
    form.PerformLayout();
    Application.DoEvents();
    // Give this owned fixture input focus even when launched by a background
    // test runner. Detach immediately; no user's control is inspected or edited.
    uint ignored;
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    uint ownThread = GetCurrentThreadId();
    bool attached = foregroundThread != ownThread && AttachThreadInput(ownThread, foregroundThread, true);
    try {
      form.Activate(); SetForegroundWindow(form.Handle);
    } finally { if (attached) AttachThreadInput(ownThread, foregroundThread, false); }
    Control selected = mode == "button" ? (Control)button : mode == "password" ? password : editor;
    form.ActiveControl = selected;
    selected.Focus();
    Application.DoEvents();
    Console.WriteLine(json.Serialize(new { type = "fixture", mode = mode, processId = System.Diagnostics.Process.GetCurrentProcess().Id,
      windowHandle = form.Handle.ToInt64().ToString(), windowTitle = form.Text, expectedValue = value,
      focusedControl = form.ActiveControl == null ? "" : form.ActiveControl.GetType().Name,
      keyboardFocus = selected.Focused }));
    Console.Out.Flush();
    editor.BlockProvider = mode == "hang";
  }
  public static void Run() {
    Application.EnableVisualStyles();
    form = new Form { Text = "YU UIA migration fixture", Size = new Size(480, 160), TopMost = true, StartPosition = FormStartPosition.CenterScreen };
    editor = new FixtureEditor { Name = "fixtureEditor", Location = new Point(20, 30), Size = new Size(420, 28) };
    password = new FixtureEditor { Name = "fixturePassword", Location = new Point(20, 30), Size = new Size(420, 28), Visible = false, UseSystemPasswordChar = true };
    button = new Button { Text = "Fixture button", Location = new Point(20, 30), Size = new Size(160, 28), Visible = false };
    form.Controls.Add(editor); form.Controls.Add(button); form.Controls.Add(password);
    form.Shown += delegate { Mode("edit"); };
    Thread input = new Thread(delegate() {
      string line;
      while ((line = Console.ReadLine()) != null) {
        string mode = line;
        try { form.BeginInvoke((Action)(() => Mode(mode))); } catch (InvalidOperationException) { return; }
      }
      try { form.BeginInvoke((Action)(() => form.Close())); } catch (InvalidOperationException) { }
    });
    input.IsBackground = true;
    input.Start();
    Application.Run(form);
  }
}
'@
[YuUiaFixture]::Run()
