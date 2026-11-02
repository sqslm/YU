# An owned, transparent, non-activating Win32 test window and synthetic PNG.
# No user's foreground window, files or audio settings are modified.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Drawing,System.Web.Extensions -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
public static class YuBridgeFixture {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr module, IntPtr param);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr window, uint color, byte alpha, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool SetWindowText(IntPtr window, string title);
  static string Image() {
    using (var bitmap=new Bitmap(640,100)) using (var graphics=Graphics.FromImage(bitmap)) using (var font=new Font("Arial",32)) using (var stream=new MemoryStream()) {
      graphics.Clear(Color.White); graphics.DrawString("QINLY OCR 123",font,Brushes.Black,10,10);
      bitmap.Save(stream,System.Drawing.Imaging.ImageFormat.Png); return Convert.ToBase64String(stream.ToArray());
    }
  }
  public static void Run() {
    string title="YU bridge \u4e2d\u6587", png=Image();
    int changes=0;
    IntPtr window=CreateWindowEx(0x08080080,"STATIC",title,0x00cf0000,0,0,100,100,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(window==IntPtr.Zero) throw new Exception("Could not create test window");
    SetLayeredWindowAttributes(window,0,0,2);
    var json=new JavaScriptSerializer();
    try {
      string command="ready";
      do {
        if(command=="quit") break;
        if(command=="title") { title="YU bridge \u5df2\u6539\u540d " + (++changes); SetWindowText(window,title); }
        if(command=="minimize") ShowWindow(window,7);
        if(command=="restore") { ShowWindow(window,4); ShowWindow(window,0); }
        Console.WriteLine(json.Serialize(new { type="fixture", command=command, pid=System.Diagnostics.Process.GetCurrentProcess().Id,handle=window.ToInt64().ToString(),title=title,png=png }));
        Console.Out.Flush();
      } while((command=Console.ReadLine())!=null);
    } finally { DestroyWindow(window); }
  }
}
'@
[YuBridgeFixture]::Run()
