extends Node

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	var js := Engine.get_singleton("JavaScriptBridge")
	if js == null:
		return
	var window = js.call("get_interface", "window")
	var location = js.call("get_interface", "location")
	if window == null or location == null:
		return
	var search: Variant = location.search
	if typeof(search) == TYPE_STRING and search.contains("probe=old"):
		_probe_rejected_call(window, location)
		return
	var clerk = load("res://addons/@aviorstudio_gd-clerk/gd_clerk.gd").new()
	var origin: String = clerk._page_origin()
	window.gdClerkPageOrigin = origin
	window.gdClerkRejectsEmpty = not clerk._is_supported_origin("")
	window.gdClerkRejectsFile = not clerk._is_supported_origin("file://local")
	window.gdClerkRejectsOpaque = not clerk._is_supported_origin("null")
	window.gdClerkAcceptsPage = clerk._is_supported_origin(origin)
	window.gdClerkOriginReady = true
	clerk.free()

func _probe_rejected_call(window, location) -> void:
	window.gdClerkOldOrigin = ""
	window.gdClerkOldReady = true
	var raw: Variant = location.call("get", "origin")
	if typeof(raw) == TYPE_STRING:
		window.gdClerkOldOrigin = raw
