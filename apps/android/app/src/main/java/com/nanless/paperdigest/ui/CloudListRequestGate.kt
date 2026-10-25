package com.nanless.paperdigest.ui

/** Local screen request ownership; invalidation also retires delayed A→B→A replies. */
internal class CloudListRequestGate {
    data class Ticket internal constructor(val context: String, val month: String, internal val nonce: Long)
    private var nonce = 0L
    fun invalidate() { nonce++ }
    fun begin(context: String, month: String): Ticket { invalidate(); return Ticket(context, month, nonce) }
    fun accepts(ticket: Ticket, context: String, month: String): Boolean =
        ticket.nonce == nonce && ticket.context.isNotEmpty() && ticket.context == context && ticket.month == month
}
