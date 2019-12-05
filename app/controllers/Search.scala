package controllers

import scala.concurrent.duration._

import lila.app._
import lila.common.{ HTTPRequest, IpAddress }
import views._

final class Search(
    env: Env,
    apiC: Api
) extends LilaController(env) {

  def searchForm = env.gameSearch.forms.search

  private val RateLimitGlobal = new lila.memo.RateLimit[String](
    credits = 50,
    duration = 1 minute,
    name = "search games global",
    key = "search.games.global"
  )

  private val RateLimitPerIP = new lila.memo.RateLimit[IpAddress](
    credits = 50,
    duration = 5 minutes,
    name = "search games per IP",
    key = "search.games.ip"
  )

  def index(p: Int) = OpenBody { implicit ctx =>
    NotForBots {
      val page = p atLeast 1
      Reasonable(page, 100) {
        val ip = HTTPRequest lastRemoteAddress ctx.req
        val cost = scala.math.sqrt(page).toInt
        implicit def req = ctx.body
        env.game.cached.nbTotal flatMap { nbGames =>
          def limited = fuccess {
            val form = searchForm.bindFromRequest.withError(
              key = "",
              message = "Please only send one request at a time per IP address"
            )
            TooManyRequests(html.search.index(form, none, nbGames))
          }
          apiC.GlobalLinearLimitPerIP(ip, limited = limited) {
            RateLimitPerIP(ip, cost = cost) {
              RateLimitGlobal("-", cost = cost) {
                negotiate(
                  html = searchForm.bindFromRequest.fold(
                    failure => Ok(html.search.index(failure, none, nbGames)).fuccess,
                    data => data.nonEmptyQuery ?? { query =>
                      env.gameSearch.paginator(query, page) map (_.some)
                    } map { pager =>
                      Ok(html.search.index(searchForm fill data, pager, nbGames))
                    }
                  ),
                  api = _ => searchForm.bindFromRequest.fold(
                    failure => Ok(jsonError("Could not process search query")).fuccess,
                    data => data.nonEmptyQuery ?? { query =>
                      env.gameSearch.paginator(query, page) map (_.some)
                    } flatMap {
                      case Some(s) =>
                        env.api.userGameApi.jsPaginator(s) map {
                          Ok(_)
                        }
                      case None =>
                        BadRequest(jsonError("Could not process search query")).fuccess
                    }
                  )
                )
              }
            }
          }
        }
      }
    }
  }
}
