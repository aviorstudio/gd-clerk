class_name GdClerkHtmlExport
extends RefCounted

const CLERK_SCRIPT := '<script src="gd-clerk/clerk.browser.js"></script>'
const BRIDGE_SCRIPT := '<script src="gd-clerk/gd_clerk_bridge.js"></script>'

static func patch_html(html: String) -> String:
	if html.contains("gd-clerk/gd_clerk_bridge.js"):
		return html
	var injection := CLERK_SCRIPT + "\n" + BRIDGE_SCRIPT + "\n"
	var head := html.find("</head>")
	if head >= 0:
		return html.substr(0, head) + injection + html.substr(head)
	return injection + html
